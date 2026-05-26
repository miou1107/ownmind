#!/usr/bin/env bash
# OwnMind post-upgrade verification script (v1.17.0 P6)
#
# Usage:
#   bash verify-upgrade.sh --local    # check local components (MCP / skill / hook / VERSION)
#   bash verify-upgrade.sh --server   # server round-trip: write → read → iron-rule trigger
#   bash verify-upgrade.sh --cleanup  # clean up test data (rows tagged __upgrade_test__)
#
# Stdout uses structured prefixes (same as interactive-upgrade):
#   INFO:<code>:msg  OK:<code>:msg  ERROR:<code>:msg

set -u

OWNMIND_DIR="${HOME}/.ownmind"
CLAUDE_DIR="${HOME}/.claude"

# Make sure mktemp leftovers are cleaned on FAIL exit / Ctrl-C (per review: mktemp trap cleanup).
INIT_TMP=""
WRITE_TMP=""
READ_TMP=""
trap 'rm -f "${INIT_TMP:-}" "${WRITE_TMP:-}" "${READ_TMP:-}" 2>/dev/null || true' EXIT

STEP() { echo "INFO:$1:$2"; }
OK()   { echo "OK:$1:$2"; }
FAIL() { echo "ERROR:$1:$2"; exit 1; }

MODE="${1:-}"

# --- Read credentials (uses the key/url configured in the OwnMind MCP) ---
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
    STEP "local_start" "Checking local components"
    # 1. MCP binary
    [ -f "${OWNMIND_DIR}/mcp/index.js" ] || FAIL "mcp_missing" "MCP server file not found"
    # 2. package.json version
    [ -f "${OWNMIND_DIR}/package.json" ] || FAIL "pkg_missing" "package.json not found"
    VERSION=$(node -p "require('${OWNMIND_DIR}/package.json').version" 2>/dev/null || echo "")
    [ -n "${VERSION}" ] || FAIL "version_unreadable" "Cannot read package.json version"
    # 3. Claude Code skill
    if [ -d "${CLAUDE_DIR}/skills/ownmind-memory" ]; then
      [ -f "${CLAUDE_DIR}/skills/ownmind-memory/SKILL.md" ] || FAIL "skill_missing" "ownmind-memory SKILL.md not found"
    fi
    # 4. Session hook
    [ -x "${CLAUDE_DIR}/hooks/ownmind-session-start.sh" ] || FAIL "hook_missing" "session-start hook not found or not executable"
    OK "local" "Local components present (version ${VERSION})"
    ;;

  --server)
    STEP "server_start" "Server round-trip verification"
    CREDS=$(read_creds)
    [ -n "${CREDS}" ] || FAIL "no_creds" "API credentials not found"
    API_KEY=$(echo "${CREDS}" | sed -n '1p')
    API_URL=$(echo "${CREDS}" | sed -n '2p')
    [ -n "${API_KEY}" ] && [ -n "${API_URL}" ] || FAIL "no_creds" "API_KEY / API_URL is empty"

    # 1. Server reachable
    STEP "ping" "Connecting to ${API_URL}/health"
    HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 5 "${API_URL}/health" 2>&1 || echo "000")
    [ "${HTTP_CODE}" = "200" ] || FAIL "server_unreachable" "Server responded ${HTTP_CODE} (expected 200)"
    OK "ping" "Server reachable"

    # 2. Acquire sync_token (server requires init before any write, else 409).
    # While we're here, grab the init response for the iron-rule check in step 5 to save a round-trip.
    STEP "init" "Calling /api/memory/init to get sync_token"
    INIT_TMP=$(mktemp)
    INIT_CODE=$(curl -s -o "${INIT_TMP}" -w "%{http_code}" --max-time 10 \
      -H "Authorization: Bearer ${API_KEY}" \
      "${API_URL}/api/memory/init?compact=true" 2>&1)
    INIT_RES=$(cat "${INIT_TMP}"); rm -f "${INIT_TMP}"
    [ "${INIT_CODE}" = "200" ] || FAIL "init_failed" "init responded ${INIT_CODE}: $(echo "${INIT_RES}" | head -c 200)"
    SYNC_TOKEN=$(echo "${INIT_RES}" | node -e "
      let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{
        try { console.log(JSON.parse(d).sync_token||''); } catch(_) { console.log(''); }
      });
    " 2>/dev/null)
    [ -n "${SYNC_TOKEN}" ] || FAIL "no_sync_token" "init response missing sync_token: $(echo "${INIT_RES}" | head -c 200)"
    OK "init" "sync_token acquired"

    # 3. Write test memory (is_test=true, with sync_token)
    TEST_NAME="__upgrade_test__$(date +%s)__$(hostname | tr -d '[:space:]')"
    STEP "write" "Writing test memory ${TEST_NAME}"
    WRITE_TMP=$(mktemp)
    WRITE_CODE=$(curl -s -o "${WRITE_TMP}" -w "%{http_code}" --max-time 10 -X POST \
      -H "Authorization: Bearer ${API_KEY}" \
      -H "Content-Type: application/json" \
      -d "{\"title\":\"${TEST_NAME}\",\"type\":\"session_log\",\"content\":\"upgrade verification\",\"is_test\":true,\"tags\":[\"upgrade_test\"],\"sync_token\":\"${SYNC_TOKEN}\"}" \
      "${API_URL}/api/memory" 2>&1)
    WRITE_RES=$(cat "${WRITE_TMP}"); rm -f "${WRITE_TMP}"
    case "${WRITE_CODE}" in
      200|201) OK "write" "Test memory written" ;;
      *) FAIL "write_failed" "Write responded ${WRITE_CODE}: $(echo "${WRITE_RES}" | head -c 200)" ;;
    esac
    MEM_ID=$(echo "${WRITE_RES}" | node -e "
      let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{
        try { console.log(JSON.parse(d).id||''); } catch(_) { console.log(''); }
      });
    " 2>/dev/null)
    [ -n "${MEM_ID}" ] || FAIL "write_no_id" "Write succeeded but response had no id for round-trip"

    # 4. Read back (use the id returned by write for the round-trip; the list endpoint /api/memory does not exist).
    STEP "read" "Reading back the memory we just wrote (id=${MEM_ID})"
    READ_TMP=$(mktemp)
    READ_CODE=$(curl -s -o "${READ_TMP}" -w "%{http_code}" --max-time 10 \
      -H "Authorization: Bearer ${API_KEY}" \
      "${API_URL}/api/memory/${MEM_ID}" 2>&1)
    READ_RES=$(cat "${READ_TMP}"); rm -f "${READ_TMP}"
    [ "${READ_CODE}" = "200" ] || FAIL "read_failed" "Read responded ${READ_CODE}: $(echo "${READ_RES}" | head -c 200)"
    echo "${READ_RES}" | grep -q "${TEST_NAME}" \
      || FAIL "read_mismatch" "Read returned 200 but title did not match (possible sync lag at the data layer)"
    OK "read" "Round-trip OK"

    # 5. Iron-rule mechanism health (reuse the init response from step 2).
    STEP "iron_rule" "Checking iron-rule mechanism"
    echo "${INIT_RES}" | grep -q "iron_rules_digest\|iron_rule" \
      && OK "iron_rule" "Iron-rule digest loaded" \
      || STEP "iron_rule_warn" "init API did not return iron_rules_digest (the user may simply have no iron rules)"

    OK "server" "Server verification passed"
    ;;

  --cleanup)
    STEP "cleanup_start" "Cleaning test data (rows with is_test=true and __upgrade_test__ prefix)"
    CREDS=$(read_creds)
    [ -n "${CREDS}" ] || FAIL "no_creds" "Credentials not found"
    API_KEY=$(echo "${CREDS}" | sed -n '1p')
    API_URL=$(echo "${CREDS}" | sed -n '2p')

    DELETE_RES=$(curl -sf --max-time 10 -X DELETE \
      -H "Authorization: Bearer ${API_KEY}" \
      "${API_URL}/api/memory/test-cleanup?name_prefix=__upgrade_test__" 2>&1)
    # The API may not be deployed yet — fail-open (failure doesn't block).
    if [ -n "${DELETE_RES}" ] && echo "${DELETE_RES}" | grep -q "deleted"; then
      OK "cleanup" "Test data cleaned"
    else
      STEP "cleanup_warn" "Cleanup API didn't respond or returned unexpectedly; super_admin can clean manually via the dashboard (filter title LIKE __upgrade_test__)"
    fi
    ;;

  *)
    echo "Usage: $0 [--local|--server|--cleanup]"
    exit 2
    ;;
esac

exit 0
