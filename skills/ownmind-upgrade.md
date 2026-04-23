---
name: ownmind-upgrade
description: OwnMind 版本查詢 + 互動式安裝/升級/修復。user 說「查版本」「版本多少」觸發版本檢查。「升級 OwnMind」「裝 OwnMind」「重裝 OwnMind」「修 OwnMind」「OwnMind 壞了」都走 bootstrap 自動判斷環境+狀態後執行（沒裝就安裝、壞了就修復、有裝就升級）。「暫緩升級」則 snooze 廣播 24h。
user_invocable: true
---

# OwnMind 版本查詢 + Universal Bootstrap Skill (v1.17.6)

此 skill 封裝完整生命週期：**查版本 → 自動偵測環境/狀態 → 執行正確動作 → 完成**。

一句指令解決所有情境：沒裝、裝舊版、裝壞掉、已最新。

---

## 四種觸發模式

### 模式 A：查版本 + 同步狀況（唯讀）

User 說：
- 「查版本」「查一下版本」「我的版本」「我的 OwnMind 版本」
- 「版本多少」「現在版本」「版號」「OwnMind 版號」
- 「check version」「what version」

**流程**：

```bash
bash ~/.ownmind/scripts/check-sync.sh
```

> 若 `~/.ownmind` 不存在 → 直接回「尚未安裝 OwnMind，可說『裝 OwnMind』一鍵安裝」，走模式 D。

輸出格式（每行 `KEY:value`）：
```
L1_REMOTE:in_sync | behind count=N | not_git | error
L2_SERVER:in_sync version=X.Y.Z | outdated client=X.Y.Z server=A.B.C | ahead ... | error ...
L3_DEPLOY:in_sync | drifted count=N
L3_DRIFT_FILE:<path>
OVERALL:in_sync | needs_upgrade
```

**回報 user 的邏輯**：
- `OVERALL:in_sync` → 「已是最新 vX.Y.Z，全部同步正常」
- `OVERALL:needs_upgrade` → 告訴 user 差在哪，問「**要我現在幫你升級嗎？**」
  - 同意 → 走模式 B
  - 拒絕 → 提示「可說『暫緩升級』延後 24 小時」
- `L2_SERVER:ahead` → 「你在 pre-release（client 比 server 新），無需升級」

### 模式 B / D：Universal Bootstrap（裝 / 升級 / 修復）

這三個情境走**同一支 `bootstrap.sh` / `bootstrap.ps1`**。AI 只要偵測 OS 跑對版本即可，腳本自己判斷 `~/.ownmind` 狀態並分支：

| `~/.ownmind` 狀態 | Bootstrap 執行的動作 |
|-------------------|-------------------|
| 不存在 | `git clone` + `install.sh/.ps1`（Mode D — 首次安裝） |
| 存在但非 git repo | 備份到 `~/.ownmind.broken.<timestamp>` → 重 clone + install（Mode D — 修復） |
| 是 git repo | 轉交 `interactive-upgrade.sh/.ps1`（Mode B — 正常升級） |

User 說出下列任一句都觸發 bootstrap：
- **升級**：「升級 OwnMind」「我要升級」「更新 OwnMind」「upgrade ownmind」
- **安裝**：「裝 OwnMind」「安裝 OwnMind」「幫我裝 OwnMind」「install ownmind」
- **修復**：「修 OwnMind」「重裝 OwnMind」「OwnMind 壞了」「OwnMind 出錯」「repair ownmind」

也由模式 A 自動導流（`needs_upgrade` 且 user 回 yes）。

### 模式 C：Snooze（延後提醒）

- 「暫緩升級」「先不要」「稍後再升級」「晚點再說」「skip」「snooze」

---

## 執行流程（Bootstrap — 模式 B / D）

### Step 1：偵測 OS + 選 local 或 remote

```bash
# 判斷 OS
os=$(uname -s 2>/dev/null)
```

決策：

| OS | 有 `~/.ownmind/scripts/bootstrap.sh`？ | 執行 |
|----|-------------------------------------|------|
| Darwin / Linux | 是 | `bash ~/.ownmind/scripts/bootstrap.sh` |
| Darwin / Linux | 否（首次安裝 or pre-v1.17.6） | `curl -fsSL https://kkvin.com/ownmind/bootstrap.sh \| bash` |
| Windows_NT / 找不到 uname | 是 | `powershell -ExecutionPolicy Bypass -File $HOME\.ownmind\scripts\bootstrap.ps1` |
| Windows_NT / 找不到 uname | 否 | `iwr -useb https://kkvin.com/ownmind/bootstrap.ps1 \| iex` |

**關鍵**：即使 user 說「升級」，若 `~/.ownmind` 不存在就走 remote curl/iwr；即使 user 說「裝」，若 `~/.ownmind` 已存在就走 local bootstrap（它會決定是升級還是修復）。一句指令 = 一個入口 = 對的行為。

### Step 2：跑腳本，逐行讀 stdout

輸出格式（共用於 bootstrap + interactive-upgrade）：

```
INFO:detect:檢查 OwnMind 安裝狀態（/Users/vin/.ownmind）
INFO:fresh:首次安裝，clone repo
OK:clone:clone 完成
INFO:install:執行 install.sh
OK:done:首次安裝完成
```

依 prefix 回應 user：
- `INFO:<code>:<msg>` — 「正在做：${msg}」
- `OK:<code>:<msg>` — 「${msg}」
- `ERROR:<code>:<msg>` — 立即停止、轉述錯誤 + 建議修復（下面錯誤碼表）
- `ASK:<code>:<msg>` — 等 user 回答

### Step 3：成功後 dismiss 升級廣播

讀完 `OK:done:*` 後，若是升級流程（不是首次安裝）→ dismiss 該 user 對應的 `upgrade_reminder` 廣播：

```
POST /api/broadcast/dismiss
```

讓 user 不再看到同一則升級提醒。

---

## 錯誤碼 → 引導表

Bootstrap + interactive-upgrade 共用錯誤碼：

| Error code | 意義 | 引導 user |
|------------|------|----------|
| `git_clone` | git clone 失敗（首次安裝 / 修復） | 「網路或 GitHub 權限問題，試 `curl -fsSL https://github.com` 看看通不通」 |
| `backup` | 壞掉狀態的備份失敗 | 「磁碟空間不足或權限問題，檢查 `df -h ~`」 |
| `install` | install.sh 失敗 | 「看 `~/.ownmind/logs/install-*.log` 找原因」 |
| `git_pull` | git pull 失敗（升級） | 「可能網路或 repo 有未 commit 改動。先 `cd ~/.ownmind && git status`」 |
| `npm_install` | MCP 依賴安裝失敗 | 「npm 可能過舊，試 `npm install -g npm@latest`」 |
| `verify_local` | 升級後本地元件缺失 | 「install.sh 沒跑完整。檢查 `~/.ownmind/logs/upgrade-*.log`」 |
| `verify_server` | Server round-trip 失敗 | 「網路或 server 問題。升級本身完成，下次 MCP call 會自動重試」 |

升級流程失敗時，`interactive-upgrade.sh` 會自動從 `~/.ownmind.bak.<timestamp>` 還原。Bootstrap 修復流程的備份保留在 `~/.ownmind.broken.<timestamp>`，3 天內手動清理（防滾回）。

---

## 執行流程（Snooze — 模式 C）

直接 HTTP：

```
POST /api/broadcast/dismiss
{
  "broadcast_id": <從廣播訊息取得>,
  "tool": "claude-code",
  "snooze_hours": 24
}
```

實際做法：
1. 從當前 session 剛收到的廣播中取 `broadcast_id`
2. 直接 curl 或請 user 到 Admin dashboard snooze
3. 回報：「已延後 24 小時再提醒」

---

## 注意事項

- **不要直接 edit `~/.ownmind` 裡的程式碼**（除非 user 明確授權）— 升級由 git pull 處理
- **備份保留**：
  - 正常升級：`~/.ownmind.bak.<timestamp>`（3 天內不刪）
  - 壞掉修復：`~/.ownmind.broken.<timestamp>`（3 天內手動清）
- **跨平台**：Windows 走 `.ps1` + `powershell -ExecutionPolicy Bypass`，不要 hardcode bash
- **首次安裝情境**：`~/.ownmind` 不存在時，**不要跑 `check-sync.sh`**（它會 error out），直接走 remote curl/iwr
- **失敗時明確告知**：不要靜默失敗，對照錯誤碼表給 user 下一步

---

## 整合關聯

- `scripts/bootstrap.sh` / `scripts/bootstrap.ps1` — **v1.17.6 新增**，universal 入口，三分支處理
- `scripts/interactive-upgrade.sh` / `.ps1` — 正常升級腳本，bootstrap 的 Branch 3 delegate 過來
- `scripts/check-sync.sh` — 模式 A 的版本檢查（三層 L1/L2/L3 比對）
- `install.sh` / `install.ps1` — fresh install 時由 bootstrap 呼叫
- `hooks/ownmind-session-start.sh` — SessionStart 顯示升級廣播
- `mcp/index.js` `fetchBroadcastsSafely` — 每次 MCP call 都附廣播
- `src/app.js` `GET /bootstrap.sh` / `/bootstrap.ps1` — public routes，供 curl-pipe-bash / iwr-iex 使用
- `src/jobs/nightly-upgrade-reminder.js` — 每日 03:30 建立升級廣播
