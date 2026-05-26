#!/usr/bin/env bash
# OwnMind DB Migration Runner (v1.19.2)
#
# Auto-detects which db/[0-9][0-9][0-9]_*.sql files have not yet been applied to the prod DB
# and applies them in order. Corresponds to IR-027 "only logic works" + IR-048 "deploys must
# run any pending migrations under db/".
#
# Usage:
#   bash scripts/run-migrations.sh
#
# Environment variables (optional):
#   DB_CONTAINER  — default ownmind-db; set empty to force direct psql
#   DB_USER       — default ownmind
#   DB_NAME       — default ownmind
#   DB_HOST       — direct mode; default localhost
#   DB_PORT       — direct mode; default 5432
#
# stdout format (matches interactive-upgrade.sh / bootstrap.sh — AI can parse line by line):
#   INFO:<code>:<msg>   — progress; e.g. INFO:scan:Querying applied migrations
#   OK:<code>:<msg>     — step succeeded; e.g. OK:apply:014_iron_rule_tier.sql applied
#   ERROR:<code>:<msg>  — failure and exit; e.g. ERROR:migration:016_xxx.sql failed
#
# Exit codes:
#   0 — all succeeded (including "no new migrations")
#   1 — any single migration failed (we stop at the first failure and do not try later ones)

set -u  # using an unset variable is an error; we control flow ourselves rather than via set -e

# ─── Configuration ─────────────────────────────────────────────
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

# ─── 1. Detect execution mode (docker exec ownmind-db vs direct psql) ─────
# Try `docker exec ownmind-db` first (prod and local docker compose environments).
# If the container is missing, fall back to direct psql (host/port/user/db from env vars).
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

# ─── 2. Run a single SQL file ──────────────────────────────────
# args: $1 = absolute path to the SQL file
# returns: psql exit code
run_sql() {
  local sql_file="$1"
  if [ "${MODE}" = "docker" ]; then
    # Copy the file into the container before running (avoid stdin encoding / quoting headaches).
    local basename
    basename="$(basename "${sql_file}")"
    docker cp "${sql_file}" "${DB_CONTAINER}:/tmp/${basename}" >/dev/null 2>&1 \
      && docker exec "${DB_CONTAINER}" psql -U "${DB_USER}" -d "${DB_NAME}" -v ON_ERROR_STOP=1 -f "/tmp/${basename}"
  else
    PGPASSWORD="${PGPASSWORD:-}" psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -v ON_ERROR_STOP=1 -f "${sql_file}"
  fi
}

# ─── 3. Query the DB (returns stdout) ─────────────────────────
# args: $1 = SQL string
# returns: tuples-only result
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

  # 1. First make sure the schema_migrations table exists (chicken-and-egg: we can't query it
  #    until 015 has been applied).
  STEP "bootstrap" "Ensuring schema_migrations table exists (${BOOTSTRAP_SQL})"
  if [ ! -f "${DB_DIR}/${BOOTSTRAP_SQL}" ]; then
    FAIL "no_bootstrap" "${DB_DIR}/${BOOTSTRAP_SQL} not found (required for tracking)"
  fi
  if run_sql "${DB_DIR}/${BOOTSTRAP_SQL}" >/dev/null 2>&1; then
    OK "bootstrap" "schema_migrations table ready"
  else
    FAIL "bootstrap" "Failed to apply ${BOOTSTRAP_SQL} — check DB connectivity"
  fi

  # 2. Pull the applied-migrations list.
  STEP "scan" "Querying applied migrations"
  applied="$(query_db "SELECT filename FROM schema_migrations ORDER BY filename" 2>/dev/null || true)"
  if [ -z "${applied}" ]; then
    STEP "scan" "schema_migrations is empty (first run or freshly created)"
  else
    local count
    count="$(echo "${applied}" | grep -c .)"
    STEP "scan" "${count} migration(s) already applied"
  fi

  # 3. List db/[0-9][0-9][0-9]_*.sql, sort by filename, run those that haven't been applied.
  applied_count=0
  skipped_count=0
  shopt -s nullglob
  local files=("${DB_DIR}"/[0-9][0-9][0-9]_*.sql)
  shopt -u nullglob
  if [ ${#files[@]} -eq 0 ]; then
    FAIL "no_migrations" "No migration files matching ${DB_DIR}/[0-9][0-9][0-9]_*.sql"
  fi

  # Sort (the NNN_ filename prefix guarantees lexical = numerical order).
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
      # Record into schema_migrations.
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

  # 4. Wrap up.
  if [ "${applied_count}" -eq 0 ]; then
    OK "done" "✅ No new migrations; DB schema is up to date (skipped=${skipped_count})"
  else
    OK "done" "✅ ${applied_count} migration(s) applied (skipped=${skipped_count})"
  fi
}

main "$@"
