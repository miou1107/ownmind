#!/bin/bash
# check-sync.sh — OwnMind 三層健檢（Remote / Server / Deploy drift）
# 用法：bash ~/.ownmind/scripts/check-sync.sh
# 輸出：結構化 STDOUT，給 ownmind-upgrade skill 解析
#
# 永不拋 exit code ≠ 0（避免阻斷 AI 流程），所有錯誤走 STDOUT 的 error 標籤

OWNMIND_DIR="${OWNMIND_DIR:-$HOME/.ownmind}"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"

# ============================================================
# L1 — Remote drift（~/.ownmind git HEAD vs origin/main）
# ============================================================
L1="unknown"
L1_DETAIL=""
if [ -d "${OWNMIND_DIR}/.git" ]; then
  if command -v git >/dev/null 2>&1; then
    git -C "${OWNMIND_DIR}" fetch origin main --quiet 2>/dev/null
    LOCAL_HEAD=$(git -C "${OWNMIND_DIR}" rev-parse HEAD 2>/dev/null)
    REMOTE_HEAD=$(git -C "${OWNMIND_DIR}" rev-parse origin/main 2>/dev/null)
    if [ -n "${LOCAL_HEAD}" ] && [ -n "${REMOTE_HEAD}" ]; then
      if [ "${LOCAL_HEAD}" = "${REMOTE_HEAD}" ]; then
        L1="in_sync"
      else
        BEHIND=$(git -C "${OWNMIND_DIR}" rev-list --count "HEAD..origin/main" 2>/dev/null || echo "?")
        L1="behind"
        L1_DETAIL="count=${BEHIND}"
      fi
    else
      L1="error"
      L1_DETAIL="cannot_resolve_refs"
    fi
  else
    L1="error"
    L1_DETAIL="git_not_installed"
  fi
else
  L1="not_git"
fi
echo "L1_REMOTE:${L1}${L1_DETAIL:+ ${L1_DETAIL}}"

# ============================================================
# L2 — Server version drift（client package.json vs server SERVER_VERSION）
# ============================================================
L2="unknown"
L2_DETAIL=""
CLIENT_VER=""
SERVER_VER=""

if [ -f "${OWNMIND_DIR}/package.json" ]; then
  CLIENT_VER=$(node -e "
    try { console.log(require('${OWNMIND_DIR}/package.json').version || ''); }
    catch { }
  " 2>/dev/null)
fi

# 讀 API credentials
API_KEY=""
API_URL=""
if [ -f "${CLAUDE_DIR}/settings.json" ]; then
  CREDS=$(node -e "
    try {
      const s = JSON.parse(require('fs').readFileSync('${CLAUDE_DIR}/settings.json', 'utf8'));
      const env = (s.mcpServers && s.mcpServers.ownmind && s.mcpServers.ownmind.env) || {};
      console.log(env.OWNMIND_API_KEY || '');
      console.log(env.OWNMIND_API_URL || '');
    } catch { }
  " 2>/dev/null)
  API_KEY=$(echo "${CREDS}" | sed -n '1p')
  API_URL=$(echo "${CREDS}" | sed -n '2p')
fi

if [ -n "${API_KEY}" ] && [ -n "${API_URL}" ]; then
  SERVER_VER=$(curl -sf --max-time 5 \
    -H "Authorization: Bearer ${API_KEY}" \
    "${API_URL}/api/memory/init" 2>/dev/null \
    | node -e "
      let b = '';
      process.stdin.on('data', d => b += d);
      process.stdin.on('end', () => {
        try { console.log(JSON.parse(b).server_version || ''); }
        catch { }
      });
    " 2>/dev/null)
fi

if [ -z "${CLIENT_VER}" ]; then
  L2="error"
  L2_DETAIL="cannot_read_client_version"
elif [ -z "${SERVER_VER}" ]; then
  L2="error"
  L2_DETAIL="cannot_reach_server"
else
  # Semver numeric compare（pre-release 視為低於 stable）
  CMP=$(node -e "
    const parse = v => {
      const noBuild = String(v).split('+')[0];
      const dashIdx = noBuild.indexOf('-');
      const core = dashIdx === -1 ? noBuild : noBuild.slice(0, dashIdx);
      const hasPre = dashIdx !== -1 && noBuild.slice(dashIdx + 1).length > 0;
      const segs = core.split('.').slice(0, 3).map(s => parseInt(s, 10));
      if (segs.length < 3 || segs.some(n => isNaN(n))) return [0, 0, 0, 0];
      return [segs[0], segs[1], segs[2], hasPre ? 0 : 1];
    };
    const a = parse('${CLIENT_VER}');
    const b = parse('${SERVER_VER}');
    for (let i = 0; i < 4; i++) {
      if (a[i] !== b[i]) { console.log(a[i] < b[i] ? -1 : 1); process.exit(0); }
    }
    console.log(0);
  " 2>/dev/null)
  case "${CMP}" in
    -1) L2="outdated"; L2_DETAIL="client=${CLIENT_VER} server=${SERVER_VER}" ;;
    1)  L2="ahead"; L2_DETAIL="client=${CLIENT_VER} server=${SERVER_VER}" ;;
    0)  L2="in_sync"; L2_DETAIL="version=${CLIENT_VER}" ;;
    *)  L2="error"; L2_DETAIL="cmp_failed" ;;
  esac
fi
echo "L2_SERVER:${L2}${L2_DETAIL:+ ${L2_DETAIL}}"

# ============================================================
# L3 — Deploy drift（~/.ownmind source vs ~/.claude deployed）
# ============================================================
# 比對 pair：source → deployed
# 若 source 不存在，跳過；deployed 不存在視為 missing drift
SRC_TO_DST=(
  "${OWNMIND_DIR}/hooks/ownmind-session-start.sh|${CLAUDE_DIR}/hooks/ownmind-session-start.sh"
  "${OWNMIND_DIR}/hooks/ownmind-iron-rule-check.sh|${CLAUDE_DIR}/hooks/ownmind-iron-rule-check.sh"
  "${OWNMIND_DIR}/hooks/ownmind-worktree-setup.sh|${CLAUDE_DIR}/hooks/ownmind-worktree-setup.sh"
  "${OWNMIND_DIR}/skills/ownmind-memory.md|${CLAUDE_DIR}/skills/ownmind-memory/SKILL.md"
  "${OWNMIND_DIR}/skills/ownmind-upgrade.md|${CLAUDE_DIR}/skills/ownmind-upgrade/SKILL.md"
)

# hooks/lib/*.js 動態加入
if [ -d "${OWNMIND_DIR}/hooks/lib" ]; then
  for f in "${OWNMIND_DIR}/hooks/lib/"*.js; do
    [ -f "${f}" ] || continue
    base=$(basename "${f}")
    SRC_TO_DST+=("${f}|${CLAUDE_DIR}/hooks/lib/${base}")
  done
fi

DRIFT_COUNT=0
DRIFT_FILES=()
for pair in "${SRC_TO_DST[@]}"; do
  SRC="${pair%|*}"
  DST="${pair#*|}"
  [ -f "${SRC}" ] || continue
  if [ ! -f "${DST}" ]; then
    DRIFT_COUNT=$((DRIFT_COUNT + 1))
    DRIFT_FILES+=("${DST} (missing)")
  elif ! cmp -s "${SRC}" "${DST}"; then
    DRIFT_COUNT=$((DRIFT_COUNT + 1))
    DRIFT_FILES+=("${DST}")
  fi
done

if [ "${DRIFT_COUNT}" -eq 0 ]; then
  echo "L3_DEPLOY:in_sync"
else
  echo "L3_DEPLOY:drifted count=${DRIFT_COUNT}"
  for f in "${DRIFT_FILES[@]}"; do
    echo "L3_DRIFT_FILE:${f}"
  done
fi

# ============================================================
# OVERALL 彙總（任一層 drift → needs_upgrade）
# ============================================================
if [ "${L1}" = "behind" ] || [ "${L2}" = "outdated" ] || [ "${DRIFT_COUNT}" -gt 0 ]; then
  echo "OVERALL:needs_upgrade"
elif [ "${L1}" = "error" ] || [ "${L2}" = "error" ]; then
  echo "OVERALL:unknown_due_to_errors"
else
  echo "OVERALL:in_sync"
fi
