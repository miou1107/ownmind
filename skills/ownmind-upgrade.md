---
name: ownmind-upgrade
description: OwnMind 版本查詢 + 互動式升級。user 說「查版本」「版本多少」「我的版本」「版號」觸發版本檢查，有新版就主動問要不要升。「我要升級」「升級 OwnMind」「更新 OwnMind」直接跑升級腳本。「暫緩升級」「先不要」則 snooze 廣播 24h。
user_invocable: true
---

# OwnMind 版本查詢 + 互動式升級 Skill (v1.17.2)

此 skill 封裝完整版本管理閉環：**查版本 → 發現新版 → 使用者同意 → 自動升級 → 完成**。

---

## 三種觸發模式

### 模式 A：查版本 + 同步狀況（唯讀）

User 說出下列任一句 → **check-only 模式**：
- 「查版本」「查一下版本」「我的版本」「我的 OwnMind 版本」
- 「版本多少」「現在版本」「版號」「OwnMind 版號」
- 「check version」「what version」

**流程（用一支腳本一次搞定三層檢查）**：

```bash
bash ~/.ownmind/scripts/check-sync.sh
```

輸出格式（每行 `KEY:value`）：
```
L1_REMOTE:in_sync | behind count=N | not_git | error
L2_SERVER:in_sync version=X.Y.Z | outdated client=X.Y.Z server=A.B.C | ahead ... | error ...
L3_DEPLOY:in_sync | drifted count=N
L3_DRIFT_FILE:<path>    # 每個 drifted 檔一行（L3 drifted 時才有）
OVERALL:in_sync | needs_upgrade
```

**三層解讀**：
- **L1 Remote**：`~/.ownmind` git HEAD 跟 GitHub origin/main 是否一致
- **L2 Server**：client 的 `package.json.version` 對比 OwnMind server 回的 `server_version`
- **L3 Deploy**：`~/.claude/hooks/*`、`~/.claude/skills/*` 是否跟 `~/.ownmind/` source 一致（忘記跑 `update.sh` 會 drift）

**回報 user 的邏輯**：
- `OVERALL:in_sync` → 「已是最新 vX.Y.Z，全部同步正常」
- `OVERALL:needs_upgrade` → 依 drift 類型告訴 user 差在哪，然後問「**要我現在幫你升級嗎？**」
  - User 同意（「好」「要」「升吧」「OK」「yes」）→ 走**模式 B**
  - User 拒絕 → 提示「可說『暫緩升級』延後提醒 24 小時」
- `L2_SERVER:ahead` → 「你在 pre-release 版（client 比 server 新），無需升級」

**為什麼非 check-sync.sh 不可**：只比 `package.json.version` 不夠 — user 常見情境是 `~/.ownmind/` 被 MCP auto-update 拉到最新，但 `~/.claude/hooks/` 沒跑 `update.sh` 同步 → 新功能（例如 forced broadcast block）沒生效。必須 L3 diff 檔案才抓得到。

### 模式 B：升級（直接執行）

User 說出下列任一句 → **跳過確認直接跑升級**：
- 「我要升級」「我要升級 OwnMind」「升級 OwnMind」「幫我升 OwnMind」「更新 OwnMind」「upgrade ownmind」

也由模式 A 自動導流（user 回 yes 時）。

### 模式 C：Snooze（延後提醒）

- 「暫緩升級」「先不要」「稍後再升級」「晚點再說」「skip」「snooze」

---

## 執行流程（升級，模式 B）

### Step 1：偵測 OS + 選對 script

```bash
# Mac / Linux：
~/.ownmind/scripts/interactive-upgrade.sh

# Windows：
powershell -ExecutionPolicy Bypass -File ~/.ownmind/scripts/interactive-upgrade.ps1
```

用 `uname -s` 或 `$OS` 環境變數判斷：
- `Darwin` → macOS → bash
- `Linux` → bash
- `Windows_NT` / 找不到 uname → PowerShell

### Step 2：跑 script，逐行讀 stdout

script 會輸出類似：
```
INFO:check:檢查 OwnMind 目錄是否存在
INFO:backup:備份到 /Users/vin/.ownmind.bak.20260422-153000
OK:backup:備份完成
INFO:pull:拉取最新 OwnMind
OK:pull:git pull 成功
...
OK:done:升級完成 → 版本：1.17.0
```

依 prefix 回應：
- `INFO:<code>:<msg>` — 告訴 user「正在做：${msg}」
- `OK:<code>:<msg>` — 告訴 user「${msg}」
- `ERROR:<code>:<msg>` — 立即停止、轉述錯誤 + 建議修復（下面錯誤碼表）
- `ASK:<code>:<msg>` — 等 user 回答

### Step 3：成功後 dismiss 升級廣播

讀完 `OK:done:*` 後，呼叫 MCP：
```
ownmind_search({ query: "upgrade_reminder" })  // 或直接 API：POST /api/broadcast/dismiss
```
讓 user 不再看到同一則升級提醒。

---

## 錯誤碼 → 引導表

| Error code | 意義 | 引導 user |
|------------|------|----------|
| `no_ownmind` | `~/.ownmind` 不存在 | 「OwnMind 還沒安裝，請先跑 install.sh 初始安裝」|
| `no_git` | `~/.ownmind` 不是 git repo | 「`~/.ownmind` 結構異常，建議備份後重新安裝」|
| `backup_failed` | 備份失敗 | 「磁碟空間不足或權限問題，請檢查 `df -h ~`」|
| `git_pull` | git pull 失敗 | 「可能網路問題或 repo 有未 commit 改動。先 `cd ~/.ownmind && git status` 看看」|
| `npm_install` | MCP 依賴安裝失敗 | 「npm 可能版本過舊。可試 `npm install -g npm@latest` 後再升」|
| `install` | install.sh 失敗 | 「看 `~/.ownmind/logs/upgrade-<timestamp>.log` 找原因」|
| `verify_local` | 本地元件缺失 | 「升級後找不到必要檔案，可能 install.sh 沒跑完整。檢查 log」|
| `verify_server` | Server round-trip 失敗 | 「網路或 server 問題。升級本身已完成，下次 call ownmind 會自動重試」|

script 失敗後會自動從 `~/.ownmind.bak.<timestamp>` 還原，user 不會壞掉。

---

## 執行流程（Snooze）

呼叫 MCP：
```
ownmind_save 不適用。直接用 HTTP：
POST /api/broadcast/dismiss
{
  "broadcast_id": <從廣播訊息取得>,
  "tool": "claude-code",  // 或對應的 AI 工具名
  "snooze_hours": 24
}
```

實際做法：
1. 從當前 session 剛收到的廣播中取 `broadcast_id`
2. 用 `ownmind_search` 等現有工具間接呼叫，或請 user 到 dashboard snooze
3. 回報：「已延後 24 小時再提醒」

---

## 注意事項

- **不要直接 edit ~/.ownmind 裡的程式碼**（除非 user 明確授權）— 升級由 git pull 處理
- **保留備份資料夾**：`~/.ownmind.bak.<timestamp>` 升級成功後 3 天內不要自動刪（防止滾回需求）
- **跨平台檢查**：Windows user 用 PowerShell，不要 hardcode bash
- **失敗時明確告知**：不要靜默失敗，失敗就告訴 user 要手動做什麼

---

## 整合關聯

- `hooks/ownmind-session-start.sh` — SessionStart 顯示升級廣播（啟動就跳）
- `mcp/index.js` fetchBroadcastsSafely — 每次 MCP call 都附廣播（4h / 日首次）
- `src/jobs/nightly-upgrade-reminder.js` — 每日 03:30 建立升級廣播
- `scripts/interactive-upgrade.sh` / `.ps1` — 本 skill 呼叫的實際升級腳本
- `scripts/verify-upgrade.sh` — 升級後驗測（由 interactive-upgrade 自動呼叫）
