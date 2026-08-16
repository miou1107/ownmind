#!/usr/bin/env bash
# Drive the ACTUAL hook Claude Code runs, the way Claude Code runs it: the command from
# ~/.claude/settings.json, with a PreToolUse payload on stdin.
#
# HOME is a throwaway. No credentials are copied — only the hook code and a rules file
# holding the one real guard. The real ~/.ownmind and ~/.claude are read, never written.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRATCH="$(mktemp -d)/realhome"
rm -rf "$SCRATCH"; mkdir -p "$SCRATCH/.ownmind/cache" "$SCRATCH/.ownmind/state" "$SCRATCH/.claude/hooks"

# the hook code, exactly as installed
cp -R "$HOME/.ownmind/hooks" "$SCRATCH/.ownmind/hooks"
cp -R "$HOME/.ownmind/shared" "$SCRATCH/.ownmind/shared" 2>/dev/null
cp "$HOME/.claude/hooks/ownmind-iron-rule-check.sh" "$SCRATCH/.claude/hooks/"

# the one real rule, no credentials
node -e '
  const fs=require("fs"), os=require("os");
  const b=JSON.parse(fs.readFileSync(os.homedir()+"/.ownmind/cache/enforcement.json","utf8"));
  const g=b.guards.find(x=>String(x.id)==="820");
  fs.writeFileSync(process.argv[1], JSON.stringify({selectors:[],guards:[g],injectables:[]}));
' "$SCRATCH/.ownmind/cache/enforcement.json"

SID="real-hook-demo"
CMD="git push origin v9.9.9"
payload() { printf '{"session_id":"%s","tool_name":"Bash","tool_input":{"command":"%s"}}' "$SID" "$CMD"; }

fire() {
  printf '%-32s ' "$1"
  OUT=$(payload | HOME="$SCRATCH" bash "$SCRATCH/.claude/hooks/ownmind-iron-rule-check.sh" 2>/dev/null)
  if [ -z "$OUT" ]; then echo "放行（掛勾完全沒講話）"; else
    echo "$OUT" | node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        try{const j=JSON.parse(s);console.log(j.decision==="block"?"擋住":("放行  ←掛勾說："+(j.systemMessage||"(沒說什麼)")));}
        catch{console.log("放行");}
      });'
  fi
}

echo "規矩 820：發版與部署一律先問 Vin"
echo "指令：$CMD"
echo "跑的是 ~/.claude/settings.json 裡登記的那一行：bash ~/.claude/hooks/ownmind-iron-rule-check.sh"
echo
echo "--- 正常流程 ---"
fire "1. AI 第一次執行"
fire "2. AI 再試一次"

ASK="$SCRATCH/.ownmind/state/gate-ask-${SID}-820.json"
echo
echo "硬碟上出現的檔案：~/.ownmind/state/$(basename "$ASK")"
echo "內容：$(cat "$ASK" 2>/dev/null || echo '(沒有)')"

echo
echo "--- AI 自己動手，沒問任何人 ---"
echo "AI 執行一行 Bash：echo '{\"approved\":true,\"approval_mode\":\"verbal\"}' > ~/.ownmind/state/$(basename "$ASK")"
printf '{"approved":true,"kind":"ask","mode":"verbal","approval_mode":"verbal"}' > "$ASK"
fire "3. AI 再執行同一個指令"

echo
echo "--- 事後翻稽核紀錄 ---"
tail -1 "$SCRATCH/.ownmind/state/gate-log.jsonl" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(JSON.stringify({action:j.action,approval_mode:j.approval_mode,guard:j.guardId??j.guard_id}));}catch{console.log("(沒有紀錄)")}})'

rm -rf "$SCRATCH"
