# OwnMind 互動式升級（給 Codex / Cursor / Antigravity / OpenCode / Windsurf / Gemini 的規則片段）

> 非 Claude Code 的 AI 工具沒有 skill system，此片段會被 install.sh / update.sh 複製並 **append 到各工具的 AGENTS.md / rules.md / GEMINI.md**。

---

## 當使用者說「我要升級」「升級 OwnMind」「幫我升 OwnMind」「更新 OwnMind」時

依 OS 跑對應 script，即時轉述 stdout：

**macOS / Linux：**
```
bash ~/.ownmind/scripts/interactive-upgrade.sh
```

**Windows：**
```
powershell -ExecutionPolicy Bypass -File "$HOME\.ownmind\scripts\interactive-upgrade.ps1"
```

Script 輸出結構：
- `INFO:<code>:<msg>` → 轉述「正在做：${msg}」
- `OK:<code>:<msg>`   → 「${msg}」
- `ERROR:<code>:<msg>` → 立即停止，轉述錯誤並依下表引導

### 錯誤碼引導

| Code | 引導 |
|------|------|
| `git_pull` | 「先 `cd ~/.ownmind && git status` 看是否有衝突」|
| `npm_install` | 「npm 版本過舊，試 `npm install -g npm@latest`」|
| `install` | 「看 `~/.ownmind/logs/upgrade-*.log` 找原因」|
| `verify_local` | 「必要檔案缺失，可能 install.sh 沒跑完」|
| 其他 | 「看 log 或請 super_admin 協助」|

升級失敗會自動從 `~/.ownmind.bak.<timestamp>` 還原，系統不會壞掉。

---

## 當使用者說「暫緩升級」「先不要」「稍後再升級」

呼叫 OwnMind MCP 或 HTTP API 把當前升級廣播 snooze 24 小時：
```
POST {OWNMIND_URL}/api/broadcast/dismiss
Authorization: Bearer <OWNMIND_API_KEY>
{
  "broadcast_id": <從廣播訊息帶的 id>,
  "tool": "<此 AI 工具名>",
  "snooze_hours": 24
}
```

回報：「已延後 24 小時再提醒」
