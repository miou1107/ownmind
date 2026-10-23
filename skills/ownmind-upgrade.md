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
# Mac / Linux / Git Bash
bash ~/.ownmind/scripts/check-sync.sh
```

```powershell
# Windows PowerShell
powershell -ExecutionPolicy Bypass -File "$HOME\.ownmind\scripts\check-sync.ps1"
```

依 OS 選對版本（`uname -s` Darwin/Linux 用 .sh、Windows_NT / 找不到 uname 用 .ps1）。輸出格式兩邊相同。

> 若 `~/.ownmind` 不存在 → 直接回「尚未安裝 OwnMind，可說『裝 OwnMind』一鍵安裝」，走模式 D。

輸出格式（每行 `KEY:value`）：
```
L1_REMOTE:in_sync | behind count=N | not_git | error
L1_REMOTE:in_sync release=vX.Y.Z | behind release=vX.Y.Z server=vA.B.C | error release=vX.Y.Z reason=<code>
L2_SERVER:in_sync version=X.Y.Z | outdated client=X.Y.Z server=A.B.C | ahead ... | error ...
L3_DEPLOY:in_sync | drifted count=N
L3_DRIFT_FILE:<path>
L4_STANDARDS:in_sync entries=N | never_synced | unreadable
OVERALL:in_sync | needs_upgrade
```

**回報 user 的邏輯**：
- 第二行 `L1_REMOTE`（帶 `release=`）是沒有 git、從壓縮檔裝的機器，跟 git 安裝一樣是正常狀態：
  `in_sync release=…` 就是最新，`behind release=… server=…` 跟 `behind count=N` 一樣處理。
- `L4_STANDARDS:never_synced` 或 `unreadable` → 回「這台機器還沒把你的規範抓下來，掛勾現在
  什麼都檢查不了；開一個新對話就會抓」。
  **如果 L1／L2／L3 都是 in_sync，到這裡就停，不要問要不要升級、也不要走模式 B。**
  規範快取是掛勾判斷用的那份檔，升級腳本不會去抓它，只有 SessionStart 會；跑升級改不了
  這一項，跑完 `OVERALL` 還是 `needs_upgrade`。
  L1／L2／L3 另外有問題的話，講完這一條再照下面處理。
- `OVERALL:in_sync` → 「已是最新 vX.Y.Z，全部同步正常」
- `OVERALL:needs_upgrade`，**而且 L1／L2／L3 至少有一層不是 in_sync** → 告訴 user 差在哪，
  問「**要我現在幫你升級嗎？**」
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

也由模式 A 自動導流（`needs_upgrade` 來自 L1／L2／L3，且 user 回 yes）。

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
| Darwin / Linux | 否（首次安裝 or pre-v1.17.6） | `curl -fsSL https://raw.githubusercontent.com/miou1107/ownmind/main/scripts/bootstrap.sh \| bash` |
| Windows_NT / 找不到 uname | 是 | `powershell -ExecutionPolicy Bypass -File $HOME\.ownmind\scripts\bootstrap.ps1` |
| Windows_NT / 找不到 uname | 否 | `iwr -useb https://raw.githubusercontent.com/miou1107/ownmind/main/scripts/bootstrap.ps1 \| iex` |

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
- `ERROR:<code>:<msg>` — 立即停止、轉述錯誤 + 建議修復（下面錯誤碼表）；後面跟著 `FIX:` 就照「安裝 OwnMind」一節處理
- `FIX:<code>:<command>` — 可以自己跑的修復指令，跑完重跑一次安裝（最多三輪）
- `ASK:<code>:<sentence>` — 把句子原文轉給 user，然後停下，不要重試
- `NEXT:<kind>[:<detail>]` — 安裝成功後的下一步，照「安裝 OwnMind」一節處理

### Step 3：成功後 dismiss 升級廣播（v1.17.18 起改由腳本自動處理）

**AI 不需要手動呼叫 `/api/broadcast/dismiss`。**

`interactive-upgrade.sh` / `.ps1` 在 `OK:done:*` **之前**會先輸出
`OK:dismiss:升級廣播已 dismiss（N 則）`，由腳本自己呼叫 `/api/broadcast/active`
撈出 `type=upgrade_reminder` 的廣播後逐一 dismiss。

理由：之前依賴 AI 在 skill 裡手動 dismiss，漏做時 user 每個 session 都會
重看到舊的升級提醒（IR-027「邏輯才有效」）。

唯一例外：user 主動說「暫緩升級」走 snooze 模式時，仍要呼叫 `/api/broadcast/dismiss`
帶 `snooze_hours`（見下方 Snooze 段落）。

---

## 安裝 OwnMind（AI 替同事安裝時照這一節）

Audience: the AI that runs the OwnMind installer on a colleague's computer. This section is self-contained; read it top to bottom before the first command.

Read `<API_URL>/install-manual.md` first (anonymous, English; `<API_URL>` is the URL in the install message the colleague pasted). It is the full manual: what the installer changes, every code it prints, troubleshooting, the permission steps. If that address is unreachable, the rules below are the same rules; the manual and this section are kept identical by a test.

### What to do

<!-- rules:start -->
1. Run the one-liner from the install message the colleague pasted, once. Read every line of its output.
2. Every line the installer prints starts with one of six prefixes:

| Prefix | Meaning | What you do |
|---|---|---|
| `INFO:<code>:<text>` | progress | nothing |
| `OK:<code>:<text>` | a step finished | nothing |
| `ERROR:<code>:<text>` | a stop | look for the `FIX:` or `ASK:` line next to it |
| `FIX:<code>:<command>` | a repair you may run yourself | run the command, then run the one-liner again |
| `ASK:<code>:<sentence>` | a stop only the person can resolve | say the sentence, then stop |
| `NEXT:<kind>:<detail>` | what to do after a successful install | see "After a successful install" |

   The text of a line is everything after its code. `ASK:<code>:` and `NEXT:verify:manual:` / `NEXT:verify:new-session:` are followed by the sentence or the title; colons inside that text belong to it.

3. Which line wins:
   - If any `ASK:` line appeared anywhere in the run, the ASK wins over every `FIX:` line: say its sentence and stop. A `FIX:` printed next to an ASK is the installer's last attempt, not an instruction.
   - `ERROR:` followed by `FIX:` (and no ASK): run the fix, then run the one-liner again. At most three rounds. After the third, tell the user what the last `ERROR:` line said and stop.
   - An `ERROR:` with no `FIX:` or `ASK:` after it: use the nearest earlier `FIX:` or `ASK:` line of the same run. If there is none, say the text of the `ERROR:` line to the user in plain words and stop.

   `FIX:` payloads are commands you can run as printed. Where one shows `<KEY>` or `<API_URL>`, put in the API key and URL from the install message (the URL is already filled in when the installer knew it).

   | `FIX:` code | What it is |
   |---|---|
   | `retry_install` | the command that runs the installer again (a download or unpack was cut off; the installer clears its own leftovers) |
   | `rerun_with_args` | the same command, to be run with the API key and URL the colleague gave you |
   | `use_fallback_source` | the command with `OWNMIND_SOURCE=github` set, so the installer skips the OwnMind server |
   | `clear_partial` | removes the unfinished download folder; then run the one-liner again |

4. `ASK:<code>:<sentence>`: say the sentence to the user exactly as printed (it is already in the user's language; codes: `no_network`, `node_download`, `disk_full`, `unsupported_os`), then stop. Do not retry, do not add advice of your own.
5. Never suggest installing git, Node.js, Homebrew, the Xcode command line tools or winget. The installer brings its own runtime; a machine on which it could not is an `ASK:` case, not a chore for the user. (The `ERROR:` text of an unsupported system may mention Node.js; it is for the log, not for you to repeat.)
6. Permissions. When your tool or the operating system refuses something the install needs, that is the one question you may ask your owner during the install. Name the permission, say what it is for and what they will see after granting it, in their language, one step at a time, naming the button or setting as it appears on screen. Then carry on with the install. Do not stop at "I do not have permission".
<!-- rules:end -->

### After a successful install

<!-- verify:start -->
The last line of the output is a `NEXT:` line.

- `NEXT:verify:new-session:<title>` (you are running inside the Claude desktop app): tell the user OwnMind is installed and that a verification conversation is opening. Then start a new session with the desktop app's own session tool (`mcp__ccd_session__start_session`), using `<title>` from the line as the session title. If the session does not start by itself and the app shows a card instead, tell the user to click the card to open the check. The brief for that session is:
  1. Confirm the OwnMind context appeared at your start.
  2. Call `ownmind_search` once.
  3. Save one memory (type project, text "OwnMind install check") and find it again with `ownmind_search`.
  4. Remove that memory with `ownmind_disable`, reason `install check`.
  5. Report one line per item, and say in the last line that the test memory was removed.
- `NEXT:verify:manual:<sentence>` (a terminal or any other tool): say the sentence to the user as printed (it is already in their language). Nothing else to do.

### Report to the user

In the user's language, three sentences at most: it is installed, what happens next, and what the user should do (usually nothing). Do not list commands, file names or codes.
<!-- verify:end -->

---

## 錯誤碼 → 引導表

這張表只適用於 git 安裝的升級與修復（模式 B）。替同事安裝時，一律照上一節「安裝 OwnMind」處理，不要用這張表的建議（它們會叫 user 自己動手，跟「不給自己加建議」衝突）。

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
- **首次安裝情境**：`~/.ownmind` 不存在時，**不要跑 `check-sync.sh` / `check-sync.ps1`**（它會 error out），直接走 remote curl/iwr
- **失敗時明確告知**：不要靜默失敗，對照錯誤碼表給 user 下一步

---

## 整合關聯

- `scripts/bootstrap.sh` / `scripts/bootstrap.ps1` — **v1.17.6 新增**，universal 入口，三分支處理
- `scripts/interactive-upgrade.sh` / `.ps1` — 正常升級腳本，bootstrap 的 Branch 3 delegate 過來
- `scripts/check-sync.sh` / `scripts/check-sync.ps1` — 模式 A 的版本檢查（四層 L1/L2/L3/L4 比對），Mac/Linux 走 .sh、Windows 走 .ps1
- `install.sh` / `install.ps1` — fresh install 時由 bootstrap 呼叫
- `hooks/ownmind-session-start.sh` — SessionStart 顯示升級廣播
- `mcp/index.js` `fetchBroadcastsSafely` — 每次 MCP call 都附廣播
- `src/app.js` `GET /bootstrap.sh` / `/bootstrap.ps1` — public routes，供 curl-pipe-bash / iwr-iex 使用
- `src/jobs/nightly-upgrade-reminder.js` — 每日 03:30 建立升級廣播
