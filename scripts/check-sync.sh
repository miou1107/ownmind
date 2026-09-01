#!/bin/bash
# check-sync.sh — four-layer OwnMind health check (Remote / Server / Deploy drift / Standards cache).
# Usage: bash ~/.ownmind/scripts/check-sync.sh
# Output: structured STDOUT for the ownmind-upgrade skill to parse.
#
# Never throws a non-zero exit code (avoid blocking the AI flow); every error goes to
# STDOUT under an `error` tag.

OWNMIND_DIR="${OWNMIND_DIR:-$HOME/.ownmind}"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"

# v1.26.7 — normalize paths for Node.exe on Windows + Git Bash.
# Without this, ${OWNMIND_DIR}=/c/Users/Vin/.ownmind makes require() fail with
# MODULE_NOT_FOUND. See path-helpers.sh.
if [ -f "${OWNMIND_DIR}/scripts/install-helpers/path-helpers.sh" ]; then
  # shellcheck disable=SC1091
  . "${OWNMIND_DIR}/scripts/install-helpers/path-helpers.sh"
else
  to_win_path() { echo "$1"; }
fi
OWNMIND_DIR_WIN="$(to_win_path "${OWNMIND_DIR}")"
CLAUDE_DIR_WIN="$(to_win_path "${CLAUDE_DIR}")"

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
    try { console.log(require('${OWNMIND_DIR_WIN}/package.json').version || ''); }
    catch { }
  " 2>/dev/null)
  # v1.17.84 — Windows file-lock fallback: when MCP node process holds package.json
  # handle, node -e require() may fail or return empty. Use grep/sed text parse
  # as a lock-tolerant fallback (read-only via stdio, no module resolver involved).
  if [ -z "${CLIENT_VER}" ]; then
    CLIENT_VER=$(grep -m1 -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "${OWNMIND_DIR}/package.json" 2>/dev/null \
      | sed -E 's/.*"([^"]+)".*/\1/')
  fi
fi

# Read API credentials.
API_KEY=""
API_URL=""
if [ -f "${CLAUDE_DIR}/settings.json" ]; then
  CREDS=$(node -e "
    try {
      const s = JSON.parse(require('fs').readFileSync('${CLAUDE_DIR_WIN}/settings.json', 'utf8'));
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
  # Semver numeric compare (pre-release ranks below stable).
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
# Comparison pairs: source → deployed.
# If `source` is missing, skip; if `deployed` is missing, count as a "missing" drift.
SRC_TO_DST=(
  "${OWNMIND_DIR}/hooks/ownmind-session-start.sh|${CLAUDE_DIR}/hooks/ownmind-session-start.sh"
  "${OWNMIND_DIR}/hooks/ownmind-iron-rule-check.sh|${CLAUDE_DIR}/hooks/ownmind-iron-rule-check.sh"
  "${OWNMIND_DIR}/skills/ownmind-memory.md|${CLAUDE_DIR}/skills/ownmind-memory/SKILL.md"
  "${OWNMIND_DIR}/skills/ownmind-upgrade.md|${CLAUDE_DIR}/skills/ownmind-upgrade/SKILL.md"
)

# hooks/lib/*.js added dynamically.
if [ -d "${OWNMIND_DIR}/hooks/lib" ]; then
  for f in "${OWNMIND_DIR}/hooks/lib/"*.js; do
    [ -f "${f}" ] || continue
    base=$(basename "${f}")
    SRC_TO_DST+=("${f}|${CLAUDE_DIR}/hooks/lib/${base}")
  done
fi

# hooks/locales/*.json added dynamically (gate-message-i18n task 7 — same pattern as
# hooks/lib above: install.sh/update.sh ship these to the ~/.claude/hooks fallback too).
if [ -d "${OWNMIND_DIR}/hooks/locales" ]; then
  for f in "${OWNMIND_DIR}/hooks/locales/"*.json; do
    [ -f "${f}" ] || continue
    base=$(basename "${f}")
    SRC_TO_DST+=("${f}|${CLAUDE_DIR}/hooks/locales/${base}")
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
# L4 — Standards cache（~/.ownmind/cache/enforcement.json）
# ============================================================
# 這一層是掛勾真正讀的那份檔。少了它，UserPromptSubmit 掛勾每一輪都會說「這台機器查不了規範」，
# 而 L1～L3 三層沒有一層看這個檔，所以上面全部 in_sync 的機器照樣可以什麼都沒在把關。
# 兩邊各自說的都是實話，可是對照起來只會讓人以為掛勾在亂講，於是把警告當雜訊。
ENFORCEMENT_CACHE="${OWNMIND_DIR}/cache/enforcement.json"
L4="never_synced"
L4_DETAIL=""
if [ -f "${ENFORCEMENT_CACHE}" ]; then
  # The path goes in as an argv element, not interpolated into the source. Every other node -e
  # in this file interpolates and relies on `cygpath -m` producing forward slashes; where
  # cygpath is absent the Windows path arrives with its backslashes intact and `\U`, `\A`, `\T`
  # are read as JS escapes, so the read throws and a healthy cache reports as unusable.
  # Measured on Windows CI, 2026-09-01.
  #
  # Well-formed means what readEnforcementBundle means by it: an object whose three lists are
  # arrays when present. A file the hooks would refuse is not a cache, however readable it is.
  L4_COUNT=$(node -e "
    try {
      const b = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
      if (!b || typeof b !== 'object' || Array.isArray(b)) { console.log(''); }
      else if (!['selectors','guards','injectables'].every(k => b[k] === undefined || Array.isArray(b[k]))) { console.log(''); }
      else {
        console.log(['selectors','guards','injectables']
          .reduce((n, k) => n + (Array.isArray(b[k]) ? b[k].length : 0), 0));
      }
    } catch { console.log(''); }
  " "${ENFORCEMENT_CACHE}" 2>/dev/null)
  if [ -n "${L4_COUNT}" ]; then
    L4="in_sync"
    L4_DETAIL="entries=${L4_COUNT}"
  else
    L4="unreadable"
  fi
fi
echo "L4_STANDARDS:${L4}${L4_DETAIL:+ ${L4_DETAIL}}"

# ============================================================
# OVERALL summary (if any layer drifts → needs_upgrade).
# ============================================================
# L4 是先問的那一題，而且它排在連不上伺服器前面。「這台機器現在什麼都沒在把關」是量得出來的
# 事實，跟「這次連不上、所以不知道」不一樣，把前者收進 unknown 會讓它從摘要裡消失。
if [ "${L4}" = "never_synced" ] || [ "${L4}" = "unreadable" ]; then
  echo "OVERALL:needs_upgrade"
elif [ "${L1}" = "behind" ] || [ "${L2}" = "outdated" ] || [ "${DRIFT_COUNT}" -gt 0 ]; then
  echo "OVERALL:needs_upgrade"
elif [ "${L1}" = "error" ] || [ "${L2}" = "error" ]; then
  echo "OVERALL:unknown_due_to_errors"
else
  echo "OVERALL:in_sync"
fi
