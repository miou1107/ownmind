#!/usr/bin/env bash
# OwnMind DB Migration Runner (v1.19.2)
#
# 自動偵測 db/[0-9][0-9][0-9]_*.sql 有哪些還沒套用到 prod DB、依編號順序套用。
# 對應 IR-027「邏輯才有效」+ IR-048「deploy 必須跑 db/ 下未套用 migration」。
#
# 用法：
#   bash scripts/run-migrations.sh
#
# 環境變數（選填）：
#   DB_CONTAINER  — 預設 ownmind-db；改成空字串可強制走直連 psql
#   DB_USER       — 預設 ownmind
#   DB_NAME       — 預設 ownmind
#   DB_HOST       — 直連模式用、預設 localhost
#   DB_PORT       — 直連模式用、預設 5432
#
# stdout 格式（跟 interactive-upgrade.sh / bootstrap.sh 一致、AI 可逐行 parse）：
#   INFO:<code>:<msg>   — 進度訊息  例：INFO:scan:Querying applied migrations
#   OK:<code>:<msg>     — 步驟成功  例：OK:apply:014_iron_rule_tier.sql applied
#   ERROR:<code>:<msg>  — 失敗、退出 例：ERROR:migration:016_xxx.sql failed
#
# 退出碼：
#   0 — 全部成功（含「沒有新 migration」）
#   1 — 任何一條 migration 失敗（失敗即停、不繼續跑下一條）

set -u  # 嚴格用未定義變數會錯、但 set -e 自己控制

# ─── 設定 ─────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DB_DIR="${REPO_ROOT}/db"
BOOTSTRAP_SQL="015_schema_migrations_table.sql"

DB_CONTAINER="${DB_CONTAINER:-ownmind-db}"
DB_USER="${DB_USER:-ownmind}"
DB_NAME="${DB_NAME:-ownmind}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"

STEP() { echo "INFO:$1:$2"; }
OK()   { echo "OK:$1:$2"; }
FAIL() { echo "ERROR:$1:$2" >&2; exit 1; }

# ─── 1. 偵測執行模式（docker exec ownmind-db vs 直連 psql）──────────────
# 預設先試 docker exec ownmind-db（prod 與本機 docker compose 環境）；
# container 不存在則 fallback 用 psql 直連 (host/port/user/db 由環境變數帶)
detect_mode() {
  if [ -n "${DB_CONTAINER}" ] \
     && command -v docker >/dev/null 2>&1 \
     && docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${DB_CONTAINER}$"; then
    MODE="docker"
    STEP "mode" "Using docker exec ${DB_CONTAINER}"
  elif command -v psql >/dev/null 2>&1; then
    MODE="psql"
    STEP "mode" "Using direct psql (host=${DB_HOST} port=${DB_PORT})"
  else
    FAIL "no_db_client" "Neither docker container '${DB_CONTAINER}' nor psql CLI is available"
  fi
}

# ─── 2. 跑單一 SQL 檔案 ───────────────────────────────────────
# args: $1 = SQL 檔案絕對路徑
# returns: psql exit code
run_sql() {
  local sql_file="$1"
  if [ "${MODE}" = "docker" ]; then
    # 把檔案 cp 進 container 再跑（避免 stdin 編碼 / 引號問題）
    local basename
    basename="$(basename "${sql_file}")"
    docker cp "${sql_file}" "${DB_CONTAINER}:/tmp/${basename}" >/dev/null 2>&1 \
      && docker exec "${DB_CONTAINER}" psql -U "${DB_USER}" -d "${DB_NAME}" -v ON_ERROR_STOP=1 -f "/tmp/${basename}"
  else
    PGPASSWORD="${PGPASSWORD:-}" psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -v ON_ERROR_STOP=1 -f "${sql_file}"
  fi
}

# ─── 3. 查 DB（回傳 stdout）──────────────────────────────────
# args: $1 = SQL 字串
# returns: tuples-only 結果
query_db() {
  local sql="$1"
  if [ "${MODE}" = "docker" ]; then
    docker exec "${DB_CONTAINER}" psql -U "${DB_USER}" -d "${DB_NAME}" -t -A -c "${sql}"
  else
    PGPASSWORD="${PGPASSWORD:-}" psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -t -A -c "${sql}"
  fi
}

# ─── Main ─────────────────────────────────────────────────────
main() {
  STEP "start" "OwnMind DB migration runner starting"
  detect_mode

  # 1. 先確保 schema_migrations 表存在（chicken-and-egg：跑 015 之前無法查表）
  STEP "bootstrap" "Ensuring schema_migrations table exists (${BOOTSTRAP_SQL})"
  if [ ! -f "${DB_DIR}/${BOOTSTRAP_SQL}" ]; then
    FAIL "no_bootstrap" "${DB_DIR}/${BOOTSTRAP_SQL} not found (required for tracking)"
  fi
  if run_sql "${DB_DIR}/${BOOTSTRAP_SQL}" >/dev/null 2>&1; then
    OK "bootstrap" "schema_migrations table ready"
  else
    FAIL "bootstrap" "Failed to apply ${BOOTSTRAP_SQL} — check DB connectivity"
  fi

  # 2. 撈已套用清單
  STEP "scan" "Querying applied migrations"
  applied="$(query_db "SELECT filename FROM schema_migrations ORDER BY filename" 2>/dev/null || true)"
  if [ -z "${applied}" ]; then
    STEP "scan" "schema_migrations is empty (first run or freshly created)"
  else
    local count
    count="$(echo "${applied}" | grep -c .)"
    STEP "scan" "${count} migration(s) already applied"
  fi

  # 3. 列 db/[0-9][0-9][0-9]_*.sql、依檔名 sort、跑沒套用過的
  applied_count=0
  skipped_count=0
  shopt -s nullglob
  local files=("${DB_DIR}"/[0-9][0-9][0-9]_*.sql)
  shopt -u nullglob
  if [ ${#files[@]} -eq 0 ]; then
    FAIL "no_migrations" "No migration files matching ${DB_DIR}/[0-9][0-9][0-9]_*.sql"
  fi

  # 排序（檔名前綴 NNN_ 保證 lexical = numerical）
  IFS=$'\n' sorted_files=($(printf '%s\n' "${files[@]}" | sort))
  unset IFS

  for sql_file in "${sorted_files[@]}"; do
    basename="$(basename "${sql_file}")"
    if echo "${applied}" | grep -qx "${basename}"; then
      STEP "skip" "✓ ${basename} (already applied)"
      skipped_count=$((skipped_count + 1))
      continue
    fi
    STEP "apply" "→ ${basename}"
    if run_sql "${sql_file}"; then
      # 記到 schema_migrations 表
      if query_db "INSERT INTO schema_migrations(filename, applied_by) VALUES('${basename}', 'auto') ON CONFLICT DO NOTHING" >/dev/null 2>&1; then
        OK "apply" "${basename} applied"
        applied_count=$((applied_count + 1))
      else
        FAIL "record" "${basename} ran but failed to write schema_migrations record"
      fi
    else
      FAIL "migration" "${basename} failed — stopping (no further migrations attempted)"
    fi
  done

  # 4. 收尾
  if [ "${applied_count}" -eq 0 ]; then
    OK "done" "✅ 沒有新 migration、DB schema 是最新（skipped=${skipped_count}）"
  else
    OK "done" "✅ ${applied_count} 條 migration 套用完成（skipped=${skipped_count}）"
  fi
}

main "$@"
