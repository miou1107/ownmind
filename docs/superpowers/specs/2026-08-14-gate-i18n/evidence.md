# Gate-message i18n — feasibility evidence (2026-08-14, measured on the primary user machine)

## 1. Chinese survives the real hook block channel byte-clean
A real headless Claude Code session ran with a PreToolUse hook that loaded a zh-TW JSON dictionary and denied a Bash call with a Chinese message (decision:block + systemMessage + permissionDecisionReason). The exact text appeared intact (twice) in the session stream-json output. Probe: scratchpad/i18n-evidence/proj/ (hook-probe.mjs, run-out.jsonl).

## 2. Env-var locale detection is dead; OS query works
Real hook subprocess env: LANG=null, LC_ALL=null, LC_CTYPE=null (envKeyCount=52). Login shell: LANG=C.UTF-8. But `defaults read -g AppleLocale` returns zh_TW. Conclusion: locale must be provisioned (OS query at SessionStart + stored preference), never inferred from env vars in the gate path.

## 3. Dictionary load latency is negligible
readFileSync + JSON.parse of the dictionary inside the hook: 0.447 ms (gate budget ~1.5 ms total).

## 4. Not yet verified (deferred to release QA)
Chinese rendering inside the interactive Claude Code systemMessage UI on the user machine. Verified separately: the same channel renders English systemMessage (live v1.26.172 gate block), and the terminal renders Chinese everywhere; the composed claim is checked at release QA.

String inventory: string-inventory.json (81 strings; 30 audience=user to localize; 43 model-facing and 8 developer-log strings stay English per track-B policy).
