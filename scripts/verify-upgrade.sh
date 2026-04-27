#!/usr/bin/env bash
# OwnMind 升級後驗測 script (v1.17.0 P6)
#
# 用法：
#   bash verify-upgrade.sh --local    # 檢查本地元件（MCP / skill / hook / VERSION）
#   bash verify-upgrade.sh --server   # Server round-trip：寫入 → 讀取 → 鐵律觸發
#   bash verify-upgrade.sh --cleanup  # 清除測試資料（__upgrade_test__ 標記）
#
# Stdout 用結構化 prefix（同 interactive-upgrade）：
#   INFO:<code>:msg  OK:<code>:msg  ERROR:<code>:msg

set -u

OWNMIND_DIR="${HOME}/.ownmind"
CLAUDE_DIR="${HOME}/.claude"

# 確保 FAIL exit / Ctrl-C 時清掉 mktemp 殘留（review 建議：mktemp trap cleanup）
INIT_TMP=""
WRITE_TMP=""
READ_TMP=""
trap 'rm -f "${INIT_TMP:-}" "${WRITE_TMP:-}" "${READ_TMP:-}" 2>/dev/null || true' EXIT

STEP() { echo "INFO:$1:$2"; }
OK()   { echo "OK:$1:$2"; }
FAIL() { echo "ERROR:$1:$2"; exit 1; }

MODE="${1:-}"

# --- 讀 credentials（使用 OwnMind MCP 設定的 key/url）---
read_creds() {
  local settings="${CLAUDE_DIR}/settings.json"
  [ -f "${settings}" ] || return 1
  node -e "
    const s = JSON.parse(require('fs').readFileSync('${settings}', 'utf8'));
    const srv = (s.mcpServers && s.mcpServers.ownmind) || {};
    const env = srv.env || {};
    console.log(env.OWNMIND_API_KEY || '');
    console.log(env.OWNMIND_API_URL || '');
  " 2>/dev/null
}

case "${MODE}" in
  --local)
    STEP "local_start" "檢查本地元件"
    # 1. MCP binary
    [ -f "${OWNMIND_DIR}/mcp/index.js" ] || FAIL "mcp_missing" "MCP server 檔案不存在"
    # 2. package.json version
    [ -f "${OWNMIND_DIR}/package.json" ] || FAIL "pkg_missing" "package.json 不存在"
    VERSION=$(node -p "require('${OWNMIND_DIR}/package.json').version" 2>/dev/null || echo "")
    [ -n "${VERSION}" ] || FAIL "version_unreadable" "讀不到 package.json version"
    # 3. Claude Code skill
    if [ -d "${CLAUDE_DIR}/skills/ownmind-memory" ]; then
      [ -f "${CLAUDE_DIR}/skills/ownmind-memory/SKILL.md" ] || FAIL "skill_missing" "ownmind-memory SKILL.md 不存在"
    fi
    # 4. Session hook
    [ -x "${CLAUDE_DIR}/hooks/ownmind-session-start.sh" ] || FAIL "hook_missing" "session-start hook 不存在或不可執行"
    OK "local" "本地元件齊全（版本 ${VERSION}）"
    ;;

  --server)
    STEP "server_start" "Server round-trip 驗測"
    CREDS=$(read_creds)
    [ -n "${CREDS}" ] || FAIL "no_creds" "找不到 API credentials"
    API_KEY=$(echo "${CREDS}" | sed -n '1p')
    API_URL=$(echo "${CREDS}" | sed -n '2p')
    [ -n "${API_KEY}" ] && [ -n "${API_URL}" ] || FAIL "no_creds" "API_KEY / API_URL 為空"

    # 1. Server 可達
    STEP "ping" "連線 ${API_URL}/health"
    HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 5 "${API_URL}/health" 2>&1 || echo "000")
    [ "${HTTP_CODE}" = "200" ] || FAIL "server_unreachable" "server 回應 ${HTTP_CODE}（應為 200）"
    OK "ping" "server 可達"

    # 2. 取 sync_token（server 強制：寫入前必須先 init，否則 409）
    # 順便拿 init response 用於 step 5 的鐵律檢查，省一次 round-trip
    STEP "init" "呼叫 /api/memory/init 取 sync_token"
    INIT_TMP=$(mktemp)
    INIT_CODE=$(curl -s -o "${INIT_TMP}" -w "%{http_code}" --max-time 10 \
      -H "Authorization: Bearer ${API_KEY}" \
      "${API_URL}/api/memory/init?compact=true" 2>&1)
    INIT_RES=$(cat "${INIT_TMP}"); rm -f "${INIT_TMP}"
    [ "${INIT_CODE}" = "200" ] || FAIL "init_failed" "init 回應 ${INIT_CODE}: $(echo "${INIT_RES}" | head -c 200)"
    SYNC_TOKEN=$(echo "${INIT_RES}" | node -e "
      let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{
        try { console.log(JSON.parse(d).sync_token||''); } catch(_) { console.log(''); }
      });
    " 2>/dev/null)
    [ -n "${SYNC_TOKEN}" ] || FAIL "no_sync_token" "init 回應缺 sync_token: $(echo "${INIT_RES}" | head -c 200)"
    OK "init" "sync_token 已取得"

    # 3. 寫 test memory（is_test=true，帶 sync_token）
    TEST_NAME="__upgrade_test__$(date +%s)__$(hostname | tr -d '[:space:]')"
    STEP "write" "寫入測試記憶 ${TEST_NAME}"
    WRITE_TMP=$(mktemp)
    WRITE_CODE=$(curl -s -o "${WRITE_TMP}" -w "%{http_code}" --max-time 10 -X POST \
      -H "Authorization: Bearer ${API_KEY}" \
      -H "Content-Type: application/json" \
      -d "{\"title\":\"${TEST_NAME}\",\"type\":\"session_log\",\"content\":\"upgrade verification\",\"is_test\":true,\"tags\":[\"upgrade_test\"],\"sync_token\":\"${SYNC_TOKEN}\"}" \
      "${API_URL}/api/memory" 2>&1)
    WRITE_RES=$(cat "${WRITE_TMP}"); rm -f "${WRITE_TMP}"
    case "${WRITE_CODE}" in
      200|201) OK "write" "測試記憶已寫入" ;;
      *) FAIL "write_failed" "寫入回應 ${WRITE_CODE}: $(echo "${WRITE_RES}" | head -c 200)" ;;
    esac
    MEM_ID=$(echo "${WRITE_RES}" | node -e "
      let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{
        try { console.log(JSON.parse(d).id||''); } catch(_) { console.log(''); }
      });
    " 2>/dev/null)
    [ -n "${MEM_ID}" ] || FAIL "write_no_id" "寫入成功但 response 無 id 可用於 round-trip"

    # 4. 讀回（用 write 回來的 id 做 round-trip；list endpoint /api/memory 不存在）
    STEP "read" "讀回剛寫入的記憶 id=${MEM_ID}"
    READ_TMP=$(mktemp)
    READ_CODE=$(curl -s -o "${READ_TMP}" -w "%{http_code}" --max-time 10 \
      -H "Authorization: Bearer ${API_KEY}" \
      "${API_URL}/api/memory/${MEM_ID}" 2>&1)
    READ_RES=$(cat "${READ_TMP}"); rm -f "${READ_TMP}"
    [ "${READ_CODE}" = "200" ] || FAIL "read_failed" "讀回 ${READ_CODE}: $(echo "${READ_RES}" | head -c 200)"
    echo "${READ_RES}" | grep -q "${TEST_NAME}" \
      || FAIL "read_mismatch" "讀回 200 但 title 不符合（資料層可能有 sync 延遲）"
    OK "read" "round-trip 正常"

    # 5. 鐵律機制健康（重用 step 2 的 init response）
    STEP "iron_rule" "檢查鐵律機制"
    echo "${INIT_RES}" | grep -q "iron_rules_digest\|iron_rule" \
      && OK "iron_rule" "鐵律 digest 可載入" \
      || STEP "iron_rule_warn" "init API 未回 iron_rules_digest（可能 user 尚無鐵律）"

    OK "server" "server 驗測通過"
    ;;

  --cleanup)
    STEP "cleanup_start" "清除測試資料（is_test=true 的 __upgrade_test__）"
    CREDS=$(read_creds)
    [ -n "${CREDS}" ] || FAIL "no_creds" "找不到 credentials"
    API_KEY=$(echo "${CREDS}" | sed -n '1p')
    API_URL=$(echo "${CREDS}" | sed -n '2p')

    DELETE_RES=$(curl -sf --max-time 10 -X DELETE \
      -H "Authorization: Bearer ${API_KEY}" \
      "${API_URL}/api/memory/test-cleanup?name_prefix=__upgrade_test__" 2>&1)
    # API 可能尚未部署，fail-open（失敗不擋）
    if [ -n "${DELETE_RES}" ] && echo "${DELETE_RES}" | grep -q "deleted"; then
      OK "cleanup" "測試資料已清"
    else
      STEP "cleanup_warn" "cleanup API 未回應或回傳異常，super_admin 可在 dashboard 手動清（篩 title LIKE __upgrade_test__）"
    fi
    ;;

  *)
    echo "Usage: $0 [--local|--server|--cleanup]"
    exit 2
    ;;
esac

exit 0
