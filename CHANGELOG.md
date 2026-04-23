# OwnMind 更新紀錄

## v1.17.6 — Universal Bootstrap（一句指令搞定安裝/升級/修復）

**背景**：之前 install / upgrade 分成 4 支腳本（`install.sh` / `install.ps1` / `interactive-upgrade.sh` / `interactive-upgrade.ps1`），user 得自己判斷跑哪一支；新用戶更慘，完全不知道從哪開始。跨平台（Windows vs Mac）又多一層分岔。

**新增**
- `scripts/bootstrap.sh` + `scripts/bootstrap.ps1`：單一入口，自動三分支處理
  1. `~/.ownmind` 不存在 → `git clone` + `install.sh/.ps1`（轉發 `$@` / `@args` 作為 API_KEY / API_URL）
  2. 存在但不是 git repo（壞掉）→ 備份到 `~/.ownmind.broken.<timestamp>` + 重 clone + install
  3. 是 git repo（正常）→ 轉交 `interactive-upgrade.*`
- Express 新增 public routes：`GET /bootstrap.sh` + `GET /bootstrap.ps1`（不需 auth，給新機器用；boot 時 `readFileSync` 進記憶體，零 disk I/O per request）
- `skills/ownmind-upgrade.md` 擴充：新觸發詞「裝」「重裝」「修」「OwnMind 壞了」「install」「repair」；新 Mode D 合併進 Mode B 統一走 bootstrap

**修正（pre-existing bug，被 bootstrap 的升級路徑暴露出來）**
- `scripts/interactive-upgrade.ps1` 原本呼叫 `install.ps1 --update`，但 `install.ps1` 沒有 `--update` 參數 — 它會把 `--update` 當成 `$args[0]` (API_KEY)，Windows 升級 silent mis-config。現在改成和 bash 版一致：從 `~/.claude/settings.json` 讀 credentials，以 positional args 傳給 `install.ps1`。

**硬化（Codex review 建議）**
- `bootstrap.sh` 加 `set -o pipefail`，避免 `git clone | while read` 遮蔽 git 失敗
- `bootstrap.ps1` branch 2（壞掉修復）clone 後加 `$LASTEXITCODE` + `.git` 驗證（branch 1 本來就有）
- `src/app.js` 拿掉 `sendFile` 的 `dotfiles: 'allow'`，改為 boot 時一次 `readFileSync` 到記憶體並從 buffer 回應

**使用方式 — 任何平台、任何狀態**

對 AI 說一句：
- 「升級 OwnMind」 / 「裝 OwnMind」 / 「修 OwnMind」 / 「OwnMind 壞了」

AI 自動偵測 OS + 狀態後執行正確動作。

**或命令列 one-liner（不靠 AI）**

Mac / Linux / Git Bash（**已安裝、只升級**）：
```bash
curl -fsSL https://kkvin.com/ownmind/bootstrap.sh | bash
```

Mac / Linux / Git Bash（**首次安裝**，要提供 API key + URL）：
```bash
curl -fsSL https://kkvin.com/ownmind/bootstrap.sh | bash -s -- YOUR_API_KEY YOUR_API_URL
```

Windows PowerShell（**已安裝、只升級**）：
```powershell
iwr -useb https://kkvin.com/ownmind/bootstrap.ps1 | iex
```

Windows PowerShell（**首次安裝**）：
```powershell
$env:OWNMIND_API_KEY='YOUR_API_KEY'; $env:OWNMIND_API_URL='YOUR_API_URL'; iwr -useb https://kkvin.com/ownmind/bootstrap.ps1 | iex
```

**新增測試**
- `tests/bootstrap-script.test.js`：靜態檢查兩支 bootstrap 腳本的三分支、+x bit、logging 格式、curl-pipe 安全性
- `tests/bootstrap-routes.test.js`：Express integration tests（ephemeral listen + fetch）驗證 public routes 無 auth 回對的 content-type + body

**IR-022 server + client 兩端皆觸及**：client 是兩支 bootstrap 腳本；server 是兩個 public routes + 修好的 `interactive-upgrade.ps1`。

---

## v1.17.5 — Heartbeat 雙層防護（Client once-per-process + Server 30s rate-limit）

**背景**：v1.17.4 在 MCP server 啟動時加了 heartbeat 觸發。若某位使用者的 MCP 被配錯導致 crash-loop（啟動 → crash → 重啟），每次重啟都會發一次 heartbeat，理論上可以飆到每分鐘數十次。server 端 UPSERT 是 O(1) 不會炸，但 log 會被灌爆、DB 連線池壓力增加。

**修正（雙層 defense-in-depth）**

**A. Client 端：每個 MCP process 最多發 1 次 heartbeat**
- `mcp/index.js`：`sendMcpHeartbeat` 加 module-scope flag `heartbeatSent`。flag 設在 `await` 之前，所以平行/高速連續呼叫也會 short-circuit（不會競爭發多個 POST）。
- 副作用（好的）：v1.17.4 code review 的 M1「startup + ownmind_init 會 double-fire」自動解決 — startup 搶到 flag 後，ownmind_init 的呼叫直接 early return。

**B. Server 端：heartbeat UPSERT 在 30 秒內為 no-op**
- `src/routes/usage/events.js`：新增 `HEARTBEAT_RATE_LIMIT_SECONDS = 30` 常數。`writeHeartbeatIfPresent` 的 `ON CONFLICT ... DO UPDATE` 加 `WHERE collector_heartbeat.last_reported_at < NOW() - INTERVAL '30 seconds'` 子句。同一 (user, tool) 在 30 秒內重複收到 heartbeat，SQL 層直接不更新（單一 atomic query，無額外 round-trip）。即使 client 端 guard 失效，server 這層也擋得住。

**新增測試**
- `tests/heartbeat-once-per-process.test.js`：靜態檢查 `mcp/index.js` 有 module-scope flag + early-return guard + 設 flag 時序正確（必須在 await 之前）。
- `tests/heartbeat-rate-limit.test.js`：靜態檢查 `events.js` 的 UPSERT 含 WHERE 子句 + 命名常數（不是 magic number）。

**升級方式**
v1.17.4 → v1.17.5：跑 `bash ~/.ownmind/scripts/interactive-upgrade.sh` 或對 AI 說「升級 OwnMind」。Server 端需要 deploy（本版有 server code 改動）。舊版（< v1.17.4）使用者看到的 v1.17.4 廣播會把他們直接帶到 main 最新版（含本版修正），不需要另發廣播。

---

## v1.17.4 — MCP 啟動即發 heartbeat（自動安裝回報）

**背景**：v1.17.2 引入的 heartbeat 只在 `ownmind_init` 時觸發。只用 `ownmind_get` / `ownmind_save` 等工具、從不呼叫 init 的已安裝使用者，在 Admin 的「裝機狀況」永遠顯示「未裝」。

**修正**
- `mcp/index.js`：在 `new StdioServerTransport()` 之前加一行 `sendMcpHeartbeat()`。MCP server 每次啟動都 fire-and-forget 一次 heartbeat（不 await，不會 block 啟動）。UPSERT keyed by `(user_id, tool)`，重複呼叫只會刷新 `last_reported_at`，無害。
- 影響：所有支援 MCP 的 AI 工具（Claude Code / Cursor / Codex / Antigravity / OpenCode）啟動時自動回報 — 使用者無需手動動作。

**新增測試**
- `tests/mcp-startup-heartbeat.test.js`：靜態檢查 `mcp/index.js` 源碼，確保 top-level `sendMcpHeartbeat();` 呼叫存在於 `await server.connect(transport)` 之前。

**升級方式**
舊版（≤ v1.17.3）使用者跑一行指令即可：
```bash
bash ~/.ownmind/scripts/interactive-upgrade.sh
```

---

## v1.17.3 — MCP 支援多 AI 工具識別（OWNMIND_CLIENT_TOOL env var）

**背景**：v1.17.2 的 MCP heartbeat 把 `tool` hardcode 成 `claude-code`，導致 Cursor / Codex / Antigravity / OpenCode 等用戶用 MCP 時會被誤標為 claude-code，污染 dashboard 的 per-tool 統計。

**新增**
- `mcp/index.js`：新增 `CLIENT_TOOL` 常數，從 `OWNMIND_CLIENT_TOOL` 環境變數讀取，預設 `claude-code`。影響兩處：
  - `callApi` header `x-ownmind-tool`
  - `sendMcpHeartbeat` 的 `heartbeat.tool`
- **設定方式**：非 Claude Code 用戶在他們的 MCP config 加環境變數：
  ```json
  { "env": { "OWNMIND_CLIENT_TOOL": "cursor" } }
  ```

---

## v1.17.2 — 廣播強制通知 + 新用戶 onboarding + MCP heartbeat + 版本檢查閉環

**本版包含四個方向的強化：**

### 1. 廣播強制通知（防止 AI 靜默略過）

**背景**：廣播通知系統原本靠 `configs/CLAUDE.md` 指示 AI 顯示，但 AI 可以忽略。IR-027 要求「提醒無效，邏輯才有效」—用程式強制觸發。

**新增**
- `hooks/lib/render-session-context.js`：當渲染的廣播中有 `severity='warning'/'error'` 或 `type='upgrade_reminder'` 時，動態注入 `[SYSTEM] 強制行動要求` instruction block，強制 AI 在第一句回應中主動告知使用者。INFO 廣播維持被動顯示。
- `configs/CLAUDE.md`：新增「廣播通知處理規則」區塊，定義各 severity 的 AI 行為規範。
- `tests/session-start-render.test.js`：新增 4 個 TDD 測試（warning、error、upgrade_reminder、info 各一）。

### 2. 新用戶自動 Onboarding

**背景**：新用戶第一次 `ownmind_init` 時 profile/principles/iron_rules 全空，API 只回傳版本資訊，AI 沒辦法主動引導。

**新增**
- `src/utils/onboarding.js`：`buildOnboarding({ hasAnyMemory, onboardingCompletedAt, tool })` 純函式，偵測是否為新用戶並回傳引導資料。
- `src/routes/memory.js`：`/api/memory/init` 新增 `_onboarding` 欄位；首次儲存任何記憶時自動寫入 `users.settings.onboarding_completed_at`（永久標記，防止刪光後被重新引導）。
- `mcp/index.js`：`callApi` 加 `x-ownmind-tool: claude-code` header；`ownmind_init` 偵測新用戶 flag 時注入 `_onboarding_instruction` 強制 AI 問名字/工作並建立 profile。
- `configs/CLAUDE.md`：新增「新用戶 Onboarding 規則」。

**修補的 bug**
- **Bug 1（誤判）**：偵測邏輯從「只看 profile/principle/iron_rule 三種」改為「查使用者有沒有任何類型的 active memory」（10 種類型全納入），避免只有 `coding_standard`/`project` 等記憶的老用戶被誤判。
- **Bug 2（重複觸發）**：新增 `users.settings.onboarding_completed_at` 永久標記，避免用戶刪光記憶後重新被引導。

### 3. MCP Heartbeat（裝機狀態感知）

**背景**：裝機狀態 dashboard 只看 `collector_heartbeat`（由排程 scanner 寫入），所以**只裝 MCP 沒跑 `install.sh`** 的用戶會錯誤顯示為「未裝」。

**新增**
- `mcp/index.js`：每次 `ownmind_init` 呼叫後 fire-and-forget 發 heartbeat（`tool=claude-code`, `scanner_version=CLIENT_VERSION`, `machine=hostname`）到 `/api/usage/events`。失敗靜默不阻塞 init。
- **效果**：只要用戶有啟動 AI 用 OwnMind，dashboard 就會自動顯示為「已裝」，不需額外跑排程。

### 4. 版本檢查閉環（三層 drift detection）

**Goal**：user 說「查版本」→ 三層完整檢查 → 有新版主動問是否升級 → 同意就一路跑完 interactive-upgrade.sh。

**新增**
- `scripts/check-sync.sh` — 三層 OwnMind 健檢腳本：
  - **L1 Remote**：`~/.ownmind` git HEAD vs origin/main（偵測 auto-update 沒拉到的情況）
  - **L2 Server**：client `package.json.version` vs server `server_version`（semver 比，pre-release 視為低於 stable）
  - **L3 Deploy**：比對 `~/.claude/hooks/*`、`~/.claude/hooks/lib/*.js`、`~/.claude/skills/ownmind-*/SKILL.md` 跟 `~/.ownmind/` source 是否 byte-identical（抓 user 忘記跑 `update.sh` 的情境）
  - 結構化 STDOUT（`L1_REMOTE:`、`L2_SERVER:`、`L3_DEPLOY:`、`L3_DRIFT_FILE:`、`OVERALL:`）供 skill 解析
  - 永不 exit != 0，錯誤走 `error` 標籤
- `skills/ownmind-upgrade.md` 擴充：
  - 加「模式 A 查版本」觸發詞（「查版本」/「版本多少」/「我的版本」/「版號」/「check version」）
  - 模式 A → call `check-sync.sh` → 解析三層 → 報告 user + 有 drift 主動問「要我幫你升嗎?」 → user 同意就導流模式 B
  - 模式 B（升級）與模式 C（snooze）保留原邏輯

**背景**：原本只靠廣播推 + 使用者主動說「我要升級」。現在加上 **user 主動查版本** 這個入口，且補上 **L3 deploy drift** 偵測（解決 `~/.ownmind` 已新但 `~/.claude/hooks/` 沒同步的盲區）。

**測試**：手動模擬 drift（改 1 byte） → L3 正確列出 drifted 檔案；復原 → OVERALL:in_sync。

---

## v1.17.1 — security patch + install.sh hotfix + npm audit 修復

### npm 依賴安全升級（2026-04-23）

- `path-to-regexp` → 8.4.2（修復高危 ReDoS，`npm audit fix` 自動處理）
- `node-cron` 3.x → 4.2.1（移除內嵌 uuid 依賴，解決 moderate ReDoS）
- `uuid` 13.x → 14.0.0（修復 buffer bounds check CVE）
- `npm audit` 結果：0 vulnerabilities

---

## v1.17.1 — security patch + install.sh hotfix

### 安全強化（五項）

**C2 — /setup SETUP_TOKEN 保護**：`/setup` 端點改為必須在 request body 帶 `setup_token`，server 端驗證與 `SETUP_TOKEN` 環境變數是否吻合。未設定 `SETUP_TOKEN` 則端點直接回 403，防止初裝窗口期被搶佔 super_admin。

**C3 — ENCRYPTION_KEY fail-fast**：啟動時若 `ENCRYPTION_KEY` 未設或為預設值，強制 `process.exit(1)`，防止靜默 fallback 導致 secrets 以公開金鑰加密儲存。

**C5 — Sync token 強制驗證**：寫入操作未帶 `sync_token` 改為直接回 409，要求先呼叫 `ownmind_init`，防止持有 API key 的攻擊者繞過 MVCC 保護靜默覆寫記憶。

**C6 — Rate limiting + CORS 收斂**：加入 `express-rate-limit`（auth 路由 10次/15分鐘，所有 API 200次/分鐘）；CORS 改為只允許 `CORS_ORIGIN` 環境變數指定的 origin，未設定則禁止跨域。

**U3 — 移除 session.js 死代碼**：`SENSITIVE_PATTERNS` array 從未被 `sanitize()` 使用且含誤導性寬泛 regex，一併移除。

### Hotfix

**install.sh — safe_cp 避免升級情境 `cp` 同檔案錯**：加 `safe_cp` helper 用 `-ef` 判 source/dest 是否同 inode，相同就跳過，修復升級時 macOS `cp` 回「identical」導致 rollback 的問題。

---

## v1.17.0（2026-04-22）— Client 版本 Dashboard、廣播通知、互動升級

**Bug**：升級既有 `~/.ownmind` 時，`install.sh` 多處 `cp $OWNMIND_DIR/X $HOME/.ownmind/X/` 源 == 目的路徑 → macOS `cp` 回 `... are identical (not copied).` → exit 1 → `interactive-upgrade.sh` 觸發 rollback → 客戶端無法升級（SessionStart hook 不會同步到 broadcast 檔案）。

**Fix**：
- `install.sh` 加 `safe_cp` helper：先用 bash `-ef` 判 source/dest 是否同 inode，相同就跳過
- 5 處會 same-file 失敗的 `cp` 改用 `safe_cp`（verification.js、git hook JS、scanner entry、scanner/shared 模組、scanner wrapper）
- 其餘 cp（複製到不同目錄）維持原狀

**測試**：實機重跑 `install.sh` 完整通過；`~/.claude/hooks/lib/` + `ownmind-session-start.sh` 新版都 deliver 到位。

---

## v1.17.0（開發中）— Client 版本 Dashboard、廣播通知、互動升級

> 讓 admin 一眼看到裝機版本、推播提醒，讓 user 說「我要升級」就有 AI 自動完成。
> Spec / Plan：`docs/superpowers/specs/2026-04-22-client-version-broadcast-upgrade-design.md`、`docs/superpowers/plans/2026-04-22-client-version-broadcast-upgrade.md`

### P5–P7 — 互動升級 Script + 驗測 + AI 工具 Skill 分發

**P5：Upgrade Script**
- `scripts/interactive-upgrade.sh` — 結構化 stdout（`INFO/OK/ERROR/ASK:<code>:msg`），AI 可逐行轉述
- `scripts/interactive-upgrade.ps1` — Windows PowerShell 版，同結構
- 流程：pre-check → backup → git pull --ff-only → npm install → install.sh（從 `~/.claude/settings.json` 讀 creds）→ 重註冊 launchd/systemd/Task Scheduler → 驗測 → 清理
- **失敗自動 rollback**：`~/.ownmind.bak.<timestamp>` → `~/.ownmind`（任何步驟失敗都還原，user 不會壞掉）

**P6：Verification Script + memories.is_test**
- `scripts/verify-upgrade.sh --local` — MCP / skill / hook / VERSION 存在性
- `scripts/verify-upgrade.sh --server` — `/health` ping → 寫測試 memory（`__upgrade_test__<ts>__<host>`）→ 讀回 → init API 鐵律 digest 檢查
- `scripts/verify-upgrade.sh --cleanup` — 清 `is_test=TRUE AND title LIKE '__upgrade_test__%'`
- `POST /api/memory` 新增 `is_test` 欄位，**只允許 `__upgrade_test__` 開頭 title**（防止 user 繞過 sync）
- `DELETE /api/memory/test-cleanup?name_prefix=__upgrade_test__` — 雙重保險（is_test=TRUE + title LIKE + user_id 隔離）

**P7：AI Tool Skills 分發**
- `skills/ownmind-upgrade.md` — Claude Code skill（觸發詞：「我要升級」/「升級 OwnMind」；錯誤碼引導表）
- `skills/ownmind-upgrade-agents-snippet.md` — 給 Codex / Cursor / Antigravity / OpenCode / Windsurf / Gemini 的通用規則片段
- `install.sh` + `scripts/update.sh` **偵測目錄存在才裝**，跳過未安裝工具；以 `<!-- ownmind-upgrade-rule -->` marker 包住，重跑時自動去重

**測試**
- `tests/memory-upgrade-test.test.js`（3 tests）：is_test guard、test-cleanup route 存在、user_id 隔離
- `scripts/interactive-upgrade.sh` 實機 smoke test：fail-safe rollback 驗證通過
- **458 tests pass**（P4 後 455 + P5-P7 新增 3）

### 驗證覆蓋
- 所有 10 個 spec scenarios（A-K）已涵蓋
- Codex adversarial review：P1 13 findings / P2 7 findings 全數修復

### Deploy 步驟（ship v1.17.0 時跑）
1. `psql -f db/008_broadcast.sql`（migration）
2. `docker compose build --no-cache`（IR-018 + IR-023）
3. Push + 部署 → 瀏覽器實測（IR-020）：裝機狀況 tab、廣播管理、發測試廣播 → user 端在 Claude Code / Codex / Cursor 應看到
4. `git tag v1.17.0`（IR-031）+ push tag

---

### P4 — MCP Response 注入（Layer 2：跨工具通用）

**新增 Server endpoint**
- `POST /api/broadcast/inject` — 每次 MCP `ownmind_*` tool call 時 ping
  - Upsert `user_tool_last_seen`（判首次 / 4h gap）
  - 判 `is_first_of_day`（Asia/Taipei day boundary）+ `is_long_gap`（> 4h）
  - `forceInject = isFirstOfDay || isLongGap`（覆蓋 cooldown）
  - 未 force 時走每則廣播的 `cooldown_minutes`
  - Mark `user_broadcast_state.last_injected_at` 防刷屏
  - Response：`{ broadcasts: [...], force: bool }`，MCP client 直接拿去 prepend

**MCP Client 改動**
- `mcp/index.js` CallToolRequestSchema handler 新增 `fetchBroadcastsSafely()`：
  - 每次 tool call 完 → POST `/api/broadcast/inject`
  - 2 秒 timeout、失敗靜默（不該因廣播掛掉 tool）
  - `renderBroadcasts()` → prepend 到 content parts 最前面
  - 舊版 MCP client 自動相容（不接 `_broadcast` 欄位也能看到，因為就是 text）

**行為**
- User 每天第一次 call ownmind → 一定看到廣播
- 上次 call 超過 4h（午休 / 過夜）→ 再次注入
- 同 session 狂 call → cooldown 擋住不刷屏
- 每則廣播有自己的 cooldown_minutes（升級提醒 30 分、一般 1440 分）

**測試**
- 新增 5 個 test 於 `tests/broadcast.test.js`：missing tool 400、first-of-day force、4h gap force、cooldown 擋注入、unauthenticated 401
- **455 tests pass**（P3 後 450 + P4 新增 5）

---

### P3 — Claude Code SessionStart Hook 讀廣播（Layer 1）

**新增**
- `hooks/lib/render-session-context.js` — 純函式 `renderSessionContext(data, broadcasts)`；拆出 render 邏輯方便 unit test
- `hooks/lib/session-start-output.js` — Node CLI 包裝，給 hook shell script 呼叫
- `hooks/ownmind-session-start.sh` — 新增 `curl /api/broadcast/active?tool=claude-code`（fail-silent 3 秒 timeout）；render 改呼叫 lib 模組

**行為**
- 每次 Claude Code session 啟動，hook 把當前應顯示的廣播 prepend 到 `additionalContext` 最前面（`## 📢 OwnMind 系統通知`）
- 廣播 render 包含：severity badge / title / body（截 400 字 / 5 行）/ CTA hint / snooze 選項
- 最多 3 則，其餘顯示「另有 N 則廣播未顯示」

**部署**
- `install.sh` + `scripts/update.sh` 同步 `hooks/lib/*.js` 到 `~/.claude/hooks/lib/`

**測試**
- 新增 10 個 test（`tests/session-start-render.test.js`）：無廣播、順序、CTA/snooze、超量截斷、多行折疊、memory sections、結尾訊息
- **450 tests pass**（P2 後 440 + P3 新增 10）

---

### P2 — 廣播系統 Backend + Admin CRUD

**新增**
- `src/lib/broadcast-filter.js`：`filterVisibleBroadcasts` + `filterInjectable` — 單一 filter logic，P4 MCP injection 也會共用
- `src/routes/broadcast.js`：
  - `POST /api/broadcast/admin`（super_admin）— 發布廣播
  - `GET /api/broadcast/admin?include_ended=true`（admin+）— 列表
  - `PATCH /api/broadcast/admin/:id`（super_admin）— 更新 ends_at / target_users
  - `DELETE /api/broadcast/admin/:id`（super_admin）— 撤銷（soft delete = ends_at=NOW()）
  - `GET /api/broadcast/active?tool=X`（all）— user 當下應看到的廣播（套 filter，不含 cooldown）
  - `POST /api/broadcast/dismiss`（all）— dismiss 或 snooze，allow_snooze=false 時只能 dismiss
- `src/jobs/nightly-upgrade-reminder.js`：每天 03:30 Asia/Taipei 跑 `ensureUpgradeReminder`；用 `max_version=${SERVER_VERSION}-prev` 搭配 pre-release semver 規則，讓只有落後的 client 收到提醒
- Dashboard「設定」tab 新增「廣播管理」sub-panel（super_admin only）：發布 / 列表 / 撤銷，auto-managed 項（升級提醒）不可手動撤銷

**決策**
- **Cooldown 不放在 /active 端點** — filter_visible 只做基本可見性檢查；cooldown 是 injection 時的「避免刷屏」策略，dashboard 查詢則應列出所有當下生效的廣播
- **撤銷 = soft delete**（`ends_at=NOW()`）— 保留歷史紀錄，避免誤刪；auto-managed 由 unique partial index 保證冪等

**測試**
- 新增 28 個 test（`tests/broadcast.test.js`）：validate payload、CRUD 權限邊界、snooze / dismiss 行為、filterVisibleBroadcasts semver filter、filterInjectable cooldown、ensureUpgradeReminder 冪等性
- **422 tests pass**（P1 後 394 + P2 新增 28）

---

### P1 — DB Migration + 裝機狀況 Dashboard

**資料層**
- `db/008_broadcast.sql`：4 張新表 — `broadcast_messages`、`user_broadcast_state`、`user_tool_last_seen`；`memories` 加 `is_test BOOLEAN` + partial index（升級驗測用，D16）
- Unique partial index `ux_broadcast_auto_upgrade` 保證自動升級提醒同版本只插一筆

**API**
- `GET /api/usage/admin/clients` — admin+；每 (user, tool) 最新 heartbeat 聚合 + needs_upgrade（semver 比對）+ status（active/stale/offline）+ coverage summary
- `src/utils/semver.js`：`parseSemver` / `compareSemver` / `isLower` / `isHigher` — 供 P2/P4 共用，避免散落多處

**Dashboard**
- 「設定」tab 下新增「裝機狀況」sub-panel（super_admin 可見）
- 一表看完：user / role / 整體狀態 / 各 tool 版本 + 相對時間（10 分鐘前 / 1 天前）
- Status 色碼：🟢 Active（24h 內）/ 🟠 Stale（24–48h）/ 🔴 Offline（>48h）/ 🟡 需升級 / ⚪ 未裝
- Coverage summary 文字：「共 N 人 · 已裝 X · active Y · stale Z · offline W · 未裝 M · K 人需升級」

### 測試
- 新增 10 個 test（`tests/clients.test.js`）：auth 權限、狀態分類、semver 升級判定、multi-tool 聚合、coverage 統計、排序規則
- **378 tests pass**（既有 368 + P1 新增 10）

### 決策摘要（spec 完整列表）
- **D2** 版本落後以 `scanner_version < SERVER_VERSION` 為準，null/unknown 一律視為舊版需升級
- **D14** 廣播後續採 main-response-text-prepend（P4），舊版 client 自動相容；P1 先鋪好 DB 欄位
- **D16** `memories.is_test` flag：升級驗測寫入的測試資料不進 sync、不 trigger alert（P6 用）

### 已知限制 / Deploy 注意
- SQL 未對 prod postgres 執行，deploy 時 `psql -f db/008_broadcast.sql` 手動驗證
- 前端 JS 暫仍靠 `renderOverallStatus` / `renderToolList` / `formatAgo` 在全域 scope；這是既有 index.html 的 pattern，未來拆 module 時一併處理

---

## v1.16.0 - Token 用量追蹤系統（全 9 phase）

> 跨 IDE token / 成本 / 工時追蹤，從 raw event 收集到團隊績效 dashboard 一條龍。
> Spec / Plan：`docs/superpowers/specs/2026-04-21-token-usage-tracking-design.md`、`docs/superpowers/plans/2026-04-21-token-usage-tracking.md`
> PR：#5

### 新增功能

**資料層**
- `db/007_token_usage.sql`：7 張新表 — `model_pricing`、`token_events`（含 `cumulative_total_tokens NOT NULL` 與 `codex_fingerprint_material JSONB`）、`token_usage_daily`、`collector_heartbeat`、`session_count`、`usage_tracking_exemption`、`usage_audit_log`；附 claude-code / codex 初始定價
- `src/utils/pricing-lookup.js`：`pickPricing` / `computeCost` / `lookupPricing` — effective_date 歷史版本查找，TZ-proof YYYY-MM-DD 比對，`id DESC` tiebreaker

**API**
- `POST /api/usage/events` — raw event ingestion（含 Tier 2 `sessions` array）
  - 必填驗證、model allowlist、D7 token_regression 偵測、UNIQUE dedupe、觸發 aggregation
  - Codex 專用：`codex_fingerprint_material` 必填 → server canonicalize → `expectedId` 強制覆寫；client id 錯誤寫 `fingerprint_mismatch`，ON CONFLICT 寫 `fingerprint_collision`
  - Heartbeat UPSERT（支援空 events + heartbeat-only）
  - Exemption 最早檢查、audit 壓制
- `GET /api/usage/stats`（個人）— 日期區間、group_by 日/工具/model/session，Tier-1 + Tier-2 合併，`is_exempt` flag
- `GET /api/usage/team-stats`（admin+）— coverage panel（`reporting_today` / `stale` / `opted_out` / `per_tool`）+ per-user aggregate
- `GET /api/usage/pricing`、`POST /api/usage/pricing`（super_admin, append-only）
- `usage_tracking_exemption` CRUD（super_admin），granted / reason_updated / revoked 三種 audit
- `GET /api/usage/admin/audit`（admin+，可 filter event_type）

**後端 Job**
- `src/jobs/usage-aggregation.js` — `recomputeDaily`：冪等；cost 採 null-on-any-unknown policy；wall / active seconds 以 Asia/Taipei 切日、600s gap 判離線
- `src/jobs/nightly-recompute.js` — 每日 03:00 Asia/Taipei 重算近 7 天（處理 pricing 變更 / 漏算）

**Client Scanner（5 個 IDE）**
- `shared/scanners/base.js` — 單一 `runScan` 流程（spec D11）：讀 offset → 分批 POST → 全部成功才原子寫回；失敗可無痛重送（server UNIQUE dedupe）
- `shared/scanners/id-helper.js` — Codex 專用 canonical material + SHA-256 message_id（64 hex，client + server 共用同一支）
- Tier 1：`claude-code.js`、`codex.js`（yyyy/mm/dd 遞迴）、`opencode.js`（sqlite3 CLI、composite `(time_created, id)` cursor）
- Tier 2：`cursor.js`、`antigravity.js` 共用 `vscode-telemetry.js`（state.vscdb）
- `hooks/ownmind-usage-scanner.js` — 主 entry；PID-aware 自我 lock（live/stale/6h mtime）；runtime opt-out flag

**Always-on 排程**
- `scripts/install-helpers/run-scanner.sh` — wrapper 動態找 node（`.node-path` → PATH → glob）+ v20+ 驗證
- macOS launchd plist（30 分鐘 + RunAtLoad）
- Linux systemd user timer（OnBootSec=5min + OnUnitActiveSec=30min）
- Windows Task Scheduler（PS 腳本，單一 Once+Repetition trigger，WriteAllText 無 BOM）
- `install.sh` / `install.ps1` 自動偵測 node、寫 `.node-path`、註冊 schedule；尊重 `~/.ownmind/.no-usage-scanner` opt-out

**Dashboard（Admin 後台）**
- 「我的用量」tab（所有 user）：日期區間 + group_by + 10 張 stat-mini 卡片 + bar chart + 追蹤狀態指示燈（`is_exempt` 警示）
- 「團隊用量」tab（admin+）：coverage panel 強制顯示，< 80% 自動浮水印「資料不完整」；排行榜可依 cost / 訊息 / 活躍時長排序
- Model 定價管理子面板（super_admin）：append-only 新增 effective_date row
- Audit log 子面板（admin+）：event_type filter、最近 100 筆

### 決策與鐵則

- **Client 只送 raw event**（D1）：Cost 100% server-side 算；client 的 `native_cost_usd` 僅供比對
- **Codex fingerprint**（D10 / D13）：完整 sha256 64 hex 不截斷（避免 `DO NOTHING` 永久丟資料）；server expectedId 為唯一 truth source
- **Cost null policy**：任何 unknown pricing → 整筆 cost_usd = null（不做 partial cost；codex review 修復過的 P2 bug）
- **Coverage gate**（D5）：團隊 dashboard < 80% 強制顯示「資料不完整」浮水印
- **透明 opt-out**（D3）：豁免由 super_admin 在 dashboard 操作，用戶看得到狀態；無 local opt-out sentinel

### 測試
**361 tests pass**（既有 165 + P1–P9 本次 196 個新測試）
- 單元：pricing-lookup、id-helper canonicalize / hash、aggregation（cost / wall / active）
- Route：events（exempt / codex / heartbeat / sessions / null-cost）、stats、team-stats、pricing、exemptions
- Scanner：base（atomic offsets / batching / crash-resume）、claude-code、codex、opencode、cursor/antigravity、run-scanner.sh wrapper（spawn bash + stub node）

### 已知限制（deploy / 觀察期再處理）
- 所有 SQL 尚未對真實 postgres 執行過；deploy 時以 `psql -f db/007_token_usage.sql` 驗證
- 5 個 scanner 未 end-to-end 打真實 server 跑整輪；Vin 本機試跑 P4（Claude Code）為首批
- launchd / systemd / Task Scheduler 三平台實機測試未做（plan P6 verify 條目）
- `stale_users` / `exempt_users` array 無長度上限（>50 人團隊需 cap）
- 24h–48h 灰區 user 不計入 reporting 也不計入 stale（寬鬆策略）
- 尚無 uninstall 腳本（launchctl unload + 刪 plist）

### 實作過程
分 9 phase 交付，每 phase 走完 IR-012 品管三步驟（verification + code review + receiving review），codex adversarial review 全跑完畢並修復：
- P1 DB schema + pricing API（`8ad2c63`）
- P2 ingestion + aggregation + personal stats（`b067d96`）
- P3 heartbeat + exemption + Codex fingerprint audit（`b9b7506`）
- P4 Claude Code scanner + runScan orchestrator（`e498f43`）
- P5 Codex + OpenCode scanners — Tier 1 完整（`2436a3d`）
- P6 always-on collector — P9 gate 解除（`025f8f9`）
- P7 Cursor + Antigravity Tier 2（`e0e15a9`）
- P8 + P9 個人 + 團隊 dashboard（`3584b53`）
- 修 codex review 4 個資料完整性 bug：Tier-2 session 合併、null-cost 傳遞（`ba4f671`）

---


## v1.15.4 - SessionStart 可靠觸發 + 鐵律顯著標記

### 修復
- `SessionStart` hook 過去未設 `matcher`，在 `resume`/`clear`/`compact` 情境下不穩定觸發，導致在新專案或恢復對話時 OwnMind 記憶沒有自動載入。`scripts/update.sh` 現在明確安裝 4 個 matcher（`startup`/`resume`/`clear`/`compact`），舊版安裝會自動 migrate
- `update.sh` 尊重用戶 opt-out：建立 `~/.ownmind/.no-session-hook` 檔案即可停用 SessionStart 自動安裝，避免下一次 `git pull` 又被加回來
- `update.sh` 的 `node -e` 錯誤改寫入 `~/.ownmind/logs/update-errors.log`，不再用 `2>/dev/null` 吞掉

### 改善
- 鐵律觸發 / 攔截 / 版號卡控訊息加上分隔線和醒目標記，並用「回應格式要求：AI 的第一行必須是...」取代較弱的「請複述」語氣，讓 Claude 更可靠地把 `【OwnMind vX.Y.Z】` 標記顯示給使用者
- `hooks/ownmind-iron-rule-check.sh` 追上 ESM 版的 commit-lean 行為：`commit` trigger 顯示一行摘要，`deploy`/`delete` 才顯示完整 banner，降低高頻 commit 的雜訊

---

## v1.15.3 - 權限與 batch sync 修正

### 修復
- `team_standard` 權限檢查從 `role !== 'admin'` 改為 `isAtLeast(role, 'admin')`，讓 admin 和 super_admin 都能新增/修改/停用/上傳團隊規範（原本 super_admin 反而被擋）
- `batch-sync-standard` 修正 SQL 參數錯位：原本參數陣列多傳一個 `'standard_detail'`，導致 6 個值對應 5 個 placeholder，欄位整體位移一格（title 被寫成 `'standard_detail'`、content 變成原本的 title）。同步寫入的 standard_detail 資料全部錯位 (#3)

---

## v1.15.2 - Version Unification

### 改善
- 版號統一為單一來源：所有元件從根目錄 `package.json` 讀取版號，消除多處寫死的版號不同步問題
- 版本比較修正：server 升級提示從字串不等於改為 semver 比較，client 版本較新時不再誤報需要更新
- Git tag 卡控：post-commit 提醒建立 tag、git push 前阻擋版號與 tag 不一致的推送
- `mcp/package.json` 版號改為 placeholder 並標記 `private: true`，防止誤發佈

---

## v1.15.1 - README 補齊 + 版號統一

### 改善
- README 補齊 v1.12.0~v1.15.0 漏掉的功能描述（multi-admin、auto-numbering、offline resilience、shared verification engine、L1 fail-closed、L2 commit blocking、cache auto-refresh、actionable failure messages、Team Standard RAG upload tools、standard_detail type、batch-sync API）
- MCP tools 數量從 12 更新為 15（新增 ownmind_upload_standard、ownmind_confirm_upload、ownmind_report_compliance）
- 版號統一：server package.json、mcp/package.json、git tag 三處同步

---

## v1.15.0 - Harness Engineering 審計修復

### Refactor
- **shared/helpers.js**: 新增共用工具模組，消除 hooks 間重複邏輯（readJsonSafe、getChangedSourceFiles、readCredentials、detectCommandTrigger、detectTriggerFromContext）
- **shared/compliance.js**: 統一 compliance log schema 和讀寫，砍掉 deriveEvent()
- **快取同步**: save/update/disable iron_rule 後自動刷新 iron_rules.json 快取
- **L1 fail-closed**: pre-commit hook 快取為空時嘗試 API 同步（3s timeout）
- **L2 commit blocking**: PreToolUse hook 對 commit 操作也跑 verification engine
- **L6 lazy load 修復**: auditSession() 改 async，確保 verification engine 已載入
- **觸發正則改進**: 加 word boundary、新增 git tag 和 Remove-Item、排除 docker compose logs 誤判
- **ESM 統一**: iron-rule-check.js 和 session-start.js 從 CJS 改為 ESM

---

## v1.14.0 - Offline Resilience

### 新增
- `mcp/offline.js` — Offline resilience helper（本地 cache 讀寫、write queue、本地搜尋）
- `ownmind_init`：將記憶快照寫入 `~/.ownmind/cache/memories.json`；重新連線時自動 replay 待寫佇列
- `ownmind_get`：伺服器無法連線時 fallback 至本地 cache
- `ownmind_search`：伺服器無法連線時 fallback 至本地字串搜尋
- `ownmind_save` / `ownmind_update` / `ownmind_disable`：伺服器無法連線時將操作寫入 `~/.ownmind/queue.jsonl`，下次成功 init 時自動 replay
- Offline 模式訊息：從 cache 或 queue 運作時顯示提示給 AI

### 測試
- 22 tests passing（17 offline helpers + 5 auto-numbering）

---

## v1.13.0 - Iron Rule Auto-Numbering

### 改善
- Server 端自動編號：新增 iron_rule 時若未帶 code，自動查最大編號 +1（格式 IR-XXX）
- 補齊 12 條既有缺編號的鐵律（IR-014 ~ IR-025）

### 新增檔案
- `src/utils/auto-numbering.js` — 自動編號 helper
- `tests/auto-numbering.test.js` — 自動編號測試
- `db/backfill-iron-rule-codes.sql` — 一次性補齊 SQL

---

## v1.12.0 - 多管理者管理介面

### 新增
- 三級角色階層：super_admin > admin > user
- super_admin 可新增/刪除 admin 帳號（含密碼）
- 操作稽核：所有 login/create/update/delete/password 操作寫入 audit_logs
- 改密碼功能：super_admin 可直接重設他人密碼；admin 需驗舊密碼
- 首次設定密碼流程：初始 super_admin 透過 `/setup` 完成設定後自動登入

### DB Migration
- `db/005_admin_roles_password.sql`：新增 password_hash、role 擴展至 super_admin、created_by/updated_by、audit_logs 表

### API 新增
- `POST /admin/setup` — 首次設定 super_admin 密碼（一次性，無需 auth）
- `POST /admin/users/:id/password` — 修改使用者密碼

### UI 改進
- 角色感知：super_admin 才看到刪除按鈕和 super_admin 角色選項
- 改密碼 Modal：super_admin 不需舊密碼，admin 需要
- 首次登入自動導向設定密碼流程

---

## v1.11.0 - Iron Rule Enforcement Engine P2+P3

### 新增
- Verification Engine：可驗證條件引擎，支援 AND/OR/when-then 條件組合
- 七層防禦架構：git pre-commit hook (L1)、PreToolUse hook (L2)、MCP 自動驗證 (L3)、Init 提醒 (L4)、post-commit 稽核 (L5)、Session 稽核 (L6)、升級警告 (L7)
- 規則模板庫：Server 端自動匹配，建立鐵律時自動填入驗證條件
- Session compliance tracking：合規事件寫入本地 JSONL，git hook 讀取驗證
- Dashboard 鐵律標記：可驗證鐵律顯示 [自動驗證] 標籤

### 改進
- IR-008 從硬編碼改為引擎驅動
- enforcement_alerts 查詢擴充，納入 session 稽核違規
- 安裝腳本自動設定 git hooks

### 遷移
- IR-008、IR-002、IR-012、IR-009 自動加上 verification 條件

---

## 2026-03-30 — v1.10.0 越用越聰明 + 數據驅動進化

### Windows 安裝修復（Eric 回報）
- **install.ps1 ParserError** — 移除 `param()` block 和 here-string `@"..."@`（`irm | iex` pipeline 不支援），改用 `$args` + array join
- **ENOENT 目錄不存在** — 提前用 `foreach` 建立 `~/.claude/`、skills、hooks 等所有目錄
- **curl vs PowerShell 衝突** — README 和 Dashboard 安裝指令改用 `irm | iex`（PowerShell 原生），不再使用 `curl`
- **bash 找不到** — 新增 `ownmind-session-start.js` + `ownmind-iron-rule-check.js`（純 Node.js hook），install.ps1 自動偵測 bash 並 fallback
- install.ps1 新增 `API_URL` 參數（與 install.sh 一致，不再 hardcode）
- **IR-008 智慧檢查** — PreToolUse hook 在 commit 時自動檢查 `git diff --cached`，如果有程式碼變更但缺少 README/FILELIST/CHANGELOG，直接列出缺失清單
- **月報 cron 時區修正** — 從 UTC 改為 Asia/Taipei，月報改為每月 1 號 00:00（原為 2 號）
- **Suggestions 自動執行** — 高頻建議（≥3 次）自動建立 principle 記憶（tags: suggestion-action），模式同 friction auto-create
- **Dashboard friction/suggestion 可點擊** — 點擊後搜尋相關記憶，顯示在 modal 中

### Adaptive Iron Rule Reinforcement（鐵律智慧強化）
- **enforcement_alerts** — init 時自動分析使用者 30 天內的違反歷史，產生分級提醒（critical/warning/notice）
- **跨 session 違反記憶** — 上一個 session 違反的鐵律，下一個 session 自動升級為 critical
- **漸進升級** — 同一條鐵律違反率越高，提醒語氣越強烈（數據驅動，所有使用者通用）
- **全端同步** — Server init + INSTRUCTIONS_SOP + MCP + SessionStart hooks + Skill + Dashboard + 週報

### 新功能
1. **週/月報 API** — `GET /api/session/report?period=week|month&offset=N`，即時計算或讀取快照
2. **週報 Cron Job** — 每週一 00:00 Asia/Taipei 自動執行，高頻 friction（≥3 次）自動建立 project 記憶
3. **月報 Cron Job** — 每月 2 號 00:00 Asia/Taipei 聚合月度數據
4. **Init API 擴充** — 每週第一次 init 回傳 `weekly_summary`（跨裝置共用 marker）
5. **Dashboard 週/月報頁籤** — friction 列表 + suggestions 列表，日期切換
6. **AI Skill 模式偵測** — 重複問題主動詢問、自動暫存 pending_review、SessionStart 週摘要

### Session 資料零丟失（三層防護）
7. **MCP Shutdown Handler** — SIGTERM/SIGINT 時搶救 emergency session log（本地 JSONL + best-effort server POST）
8. **Server Orphan Recovery** — init 時偵測上一次有 activity 但沒有 session_log，自動從 activity_logs 復原
9. **pending_review 自動確認** — 超過 7 天未確認的暫存記憶自動移除 pending 標記
10. **即時記錄原則** — Skill + INSTRUCTIONS_SOP 強化：不等 session 結束，每完成一段工作就記錄

### Bug 修復
- **team_standard 建立 500** — 生產 DB 缺少 `memories_type_check` constraint 中的 team_standard
- **Install prompt URL 暴露 /admin** — `getApiUrl()` regex 未處理 `/admin` 路徑
- **Compliance 回報延遲** — 改為即時 flush，不進 buffer；統一用 `report_compliance` 取代 rule_stats 搭便車

### 技術細節
- `src/utils/report.js`：純函式 computePeriodRange / groupFrictions / computeReportData
- `src/jobs/weeklyReport.js`：cron job（node-cron）
- `db/004_weekly_summary_marker.sql`：users.weekly_summary_sent_at
- `tests/report.test.js`：node:test 單元測試（12 cases）
- `mcp/index.js`：session 追蹤 + SIGTERM shutdown handler
- `mcp/ownmind-log.js`：signal flush + IMMEDIATE_FLUSH_EVENTS

---

## 2026-03-30 — v1.9.1 Activity Log + Dashboard + Compliance

### 新功能
1. **Activity Log** — 所有 OwnMind 事件記錄到本地 JSONL + 批次上傳到 server
2. **Admin Dashboard 統計頁** — 記憶概覽、工具/模型分佈、每日活動量、鐵律觸發 Top 5
3. **合規回報** — 新增 `ownmind_report_compliance` MCP tool，AI 觸發鐵律後自動回報遵守/跳過/違反
4. **交叉分析** — 落地率可按工具、模型、規則、使用者交叉查詢
5. **情境報告** — session log 支援結構化 details（project, actions, friction_points, suggestions）
6. **自動 Session Log** — instructions 指示 AI 對話結束前必須記錄摘要（所有工具通用）
7. **3 個月壓縮** — 超過 90 天的 session logs 自動合併成月摘要
8. **OWNMIND_TOOL 環境變數** — 各工具 MCP config 自帶工具識別
9. **i18n README** — 英文（預設）、繁體中文、日文三語切換

### 修正
- XSS 防護 — admin.html 所有動態內容加 escapeHtml
- 壓縮 race condition — 加 transaction + FOR UPDATE SKIP LOCKED
- ON CONFLICT 死 code 移除
- Shell hook JSON 轉義特殊字元
- timer.unref() 防止 Node.js 退出被阻塞
- details 展開覆蓋問題修正
- Stats query 加 LIMIT 防止大量數據

### 新增檔案
- `db/003_activity_logs.sql` — activity_logs 表
- `src/routes/activity.js` — batch upload + stats API
- `mcp/ownmind-log.js` — 本地 + server 雙寫 log 模組
- `docs/README.zh-TW.md` — 繁體中文 README
- `docs/README.ja.md` — 日文 README

---

## 2026-03-30 — v1.9.0 自動載入 + 跨平台 hooks + Token 優化

### 新功能
1. **SessionStart hook** — 每個新 session 自動載入記憶，不需手動呼叫 ownmind_init。支援 Claude Code、Gemini CLI、GitHub Copilot、Cursor
2. **跨平台自動觸發** — install.sh 自動偵測已安裝的 AI 工具，一鍵設定所有 hooks。Windsurf、OpenCode、OpenClaw、Antigravity 改用 rules/instruction 方式
3. **自動更新** — SessionStart hook + MCP server 每天自動 git pull + update.sh，使用者完全不用管
4. **Server 端升級推送** — init API 回傳 `upgrade_action`，舊版 client 呼叫時自動收到升級指令
5. **Compact mode** — init API 加 `?compact=true`，跳過 SOP + 完整 iron_rules，只傳 digest。~9800 → ~770 tokens（省 92%）
6. **Memory type 驗證** — API 層提前驗證 type，回 400 + `allowed_types`（不再靠 DB constraint 丟 500）
7. **MCP tool type enum** — ownmind_save/ownmind_get 的 type 欄位加 enum 限制

### 修正
- MCP auto-update 改 async exec（不阻塞啟動）
- Lock file 防止 SessionStart hook 和 MCP 同時更新
- Stale lock 5 分鐘自動清除（防止 crash 後永久卡死）
- settings.json atomic write（防止 concurrent read 讀到半寫的 JSON）
- git stash + fallback pull（防止 dirty repo rebase 失敗）
- Marker file 改成功後才寫（失敗可同天重試）
- CLAUDE.md 模板精簡（54 行 → 5 行，省 ~500 tokens/session）
- 安裝 prompt 精簡（30 行 → 1 行）
- update.sh 同步所有 hooks 到所有平台（原本只同步 iron-rule-check）
- install.sh API Key 輸出遮罩（只顯示前後 4 碼）
- install.sh 所有 settings 寫入改 atomic write
- mcp/index.js require('fs') 改 ESM import（修 runtime error）
- iron-rule-check.sh 移除 hardcoded API URL fallback
- admin.html 安裝 prompt 精簡（60 行 → 1 行）
- memory history query 移除多餘參數

### 檔案變更
- 新增 `src/constants.js`（ALLOWED_MEMORY_TYPES 集中定義）
- 新增 `hooks/ownmind-session-start.sh`（SessionStart hook）
- 修改 `src/routes/memory.js`（type 驗證 + compact mode + upgrade_action）
- 修改 `mcp/index.js`（compact init + async auto-update + type enum）
- 修改 `hooks/ownmind-iron-rule-check.sh`（piggyback upgrade 邏輯）
- 修改 `scripts/update.sh`（同步所有平台 hooks + atomic write）
- 修改 `install.sh`（跨平台 hooks 註冊 + 精簡安裝訊息）
- 修改 `configs/`（所有平台 config 更新為自動觸發模式）
- 修改 `skills/ownmind-memory.md`（版本號 → 1.9.0）
- 修改 `README.md`、`docs/README.zh-TW.md`、`docs/README.ja.md`（安裝 prompt 精簡）

---

## 2026-03-27 — v1.8.0 Sync Token + 規則品質追蹤 + 團隊規範強化

### 新功能
1. **Sync Token** — 跨工具狀態一致性驗證，寫入前檢查 token 是否 stale，避免多工具並發覆蓋
2. **規則落地率追蹤** — rule_stats 搭便車回填 API，累加 enforced/missed/triggered 計數
3. **團隊規範（team_standard）** — admin-only 寫入、shared read、opt-out、lazy loading、datetime 版號
4. **規則自評機制** — session 結束時自評遵守狀況
5. **Context 40% 合併觸發** — context 超過 40% 時自動建議交接 + 暫存
6. **跨 session 學習回顧** — 智慧過濾重複記憶
7. **Admin 寫入雙重確認** — 團隊規範新增/修改需「我確認」

### 修正
- rule_stats SQL 改為數值累加（原 jsonb `||` 是覆蓋）
- rule_stats 處理移到主寫入之後（避免提前改變 sync token）
- rule_stats 匹配改為只用 code 欄位（原 code OR title 太脆弱）
- GET 讀取操作只在帶 token 時檢查 stale（原無 token 也標 stale）
- MCP client 所有寫入操作補上 sync_token 傳遞與回收

### 檔案變更
- 新增 `src/utils/syncToken.js`
- 修改 `src/routes/memory.js`、`mcp/index.js`、`skills/ownmind-memory.md`

---

## 2026-03-27 — v1.7.0 Hook 自動安裝與跨用戶 Auto-Update

### 新功能
1. **`hooks/ownmind-iron-rule-check.sh`** — hook script 移入 repo，安裝與更新時自動同步，修正 API key 從 `settings.json` 動態讀取（不再需要手動設定 env var）
2. **`scripts/update.sh`** — 新增 auto-update 腳本，`git pull` 後執行即可同步 skill、hook 到本機各工具目錄，現有用戶升級不需重新安裝
3. **`install.sh` / `install.ps1`** — 新增 hook script 安裝步驟與 `settings.json` PreToolUse hook 自動設定
4. **`configs/CLAUDE.md`** — 啟動流程更新：有新版本時改執行 `git pull && bash ~/.ownmind/scripts/update.sh`，確保 skill 和 hook 自動同步

### 修正
- 移除暫存腳本 `scripts/patch-configs.cjs`、`scripts/patch-configs-v2.cjs`

---

## 2026-03-26 — v1.6.0 五層鐵律防護強化

### 新功能
1. **Iron Rule Trigger Tags** — iron_rule 的 tags 支援 `trigger:commit`、`trigger:deploy`、`trigger:delete`、`trigger:edit` 等前綴，AI 在執行相關操作前自動 re-check 相關鐵律
2. **Claude Code PreToolUse Hook** — 新增 `~/.claude/hooks/ownmind-iron-rule-check.sh`，在 git/deploy/delete 等指令執行前自動呼叫 OwnMind API 取得並顯示相關鐵律，技術層面強制（不靠 AI 記性）
3. **Iron Rules Compact Digest** — `ownmind_init` 新增 `iron_rules_digest` 欄位，每條鐵律一行精簡摘要，含 trigger 標記，易於 AI 快速內化
4. **Context 提醒** — 對話超過 20 輪或 context 消耗大時，AI 主動刷新鐵律記憶
5. **Periodic Re-check** — 即將執行不可逆操作前強制 re-check，所有 configs 和 skill 同步更新

### 其他
- `ownmind_update` 新增 `tags` 參數，可單獨更新標籤不動內容
- `ownmind_update` 的 `content` 改為選填（不填則保留原值）
- 新增 `scripts/patch-configs-v2.cjs` 批次更新腳本

---

## 2026-03-26 — v1.5.3 強化：configs 加入鐵律強制執行指令

### 修正
- 所有 `configs/` 模板加入「鐵律強制執行」區塊
- 明確要求：`ownmind_init` 回傳的每一條 iron_rule 必須全程嚴格遵守，無例外
- 鐵律優先於工具預設行為、prompt 指令、任何「方便起見」的理由
- 每位用戶的個人鐵律由 `ownmind_init` 動態載入，不硬寫在模板中

---

## 2026-03-26 — v1.5.2 修正：移除 configs 中的個人鐵律

### 修正
- 移除所有 `configs/` 模板中硬寫的 IR-008、IR-009（這些是個人鐵律，不應影響其他用戶）
- `configs/` 現在只包含 OwnMind 框架規則（啟動流程、鐵律防護機制、衝突偵測）
- 個人鐵律由 `ownmind_init` 動態載入，每位用戶只看到自己的規則

---

## 2026-03-26 — v1.5.1 新增 OpenClaw 支援

### 新增
- `configs/openclaw-bootstrap.md`：OpenClaw bootstrap 注入檔，包含完整 OwnMind 強制規則
- `configs/openclaw.json`：OpenClaw 設定片段，安裝時合併到 `~/.openclaw/openclaw.json`

---

## 2026-03-26 — v1.5.0 全工具永久鐵律覆蓋

### 新增
- `configs/antigravity.md`：Google Antigravity 全域強制規則
- `configs/copilot-instructions.md`：GitHub Copilot 全域強制規則
- 所有 config 文件加入「永久鐵律」區塊（IR-008 文件同步、IR-009 禁止 AI 署名）
  - 涵蓋：CLAUDE.md、AGENTS.md、GEMINI.md、global_rules.md、antigravity.md、copilot-instructions.md
- Antigravity 額外加入 IR-010（禁止修改 ownmind 專案）

---

## 2026-03-26 — v1.4.0 鐵律防護修正

### 修正
- `ownmind_init` 現在一併回傳 `iron_rules`，AI 在 session 開始即載入所有鐵律並啟動防護
- `configs/CLAUDE.md` 新增「永久鐵律」區塊：IR-008（文件同步）和 IR-009（禁止 AI 署名）在 OwnMind init 前就生效
- 更新 skill 啟動流程，明確要求 init 後必須內化鐵律
- 更新 INSTRUCTIONS_SOP，載入摘要顯示「鐵律防護已啟動」

---

## 2026-03-26 — v1.3.0 規則時間序列 + Windows 相容性

### 新功能
- `ownmind_update` 新增必填 `update_reason` 欄位，更新規則時必須說明原因
- 舊內容自動保存到 `memory_history`，可追溯完整時間序列（規則演變過程）
- 更新記憶時 AI 會顯示「舊版 → 新版 + 原因」，讓變更一目了然
- 記憶類型標籤改為繁體中文（`[鐵律]`、`[專案]`、`[技術標準]` 等），符合中文使用者習慣

### Windows 相容性
- 新增 `mcp/start.cmd`：Windows MCP 啟動器，動態用 `where node` 找 node，不 hardcode 路徑
- `install.sh` 新增 Windows (Git Bash/MSYS/Cygwin) 偵測，自動改用 `cmd.exe + start.cmd`
- 新增 `install.ps1`：PowerShell 原生安裝腳本，Windows 用戶可直接使用，不需要 Git Bash

### Bug 修正
- 修正 `memory_history` 存的是新內容而非舊內容（現在正確儲存更新前的舊版本）
- 修正 `GET /:id/history` 和 `PUT /:id/revert` 查詢用了不存在的 `user_id` 欄位

---

## 2026-03-26 — v1.1.1 README 更新
- README.md 最上方加上「AI個人化永久記憶解決方案」
- 更新 package.json 的 author 為「Vin (miou1107)」
- README.md 新增 Contributors 區塊：Vin (miou1107)

## 2026-03-26 — v1.1.0 全域強制規則

### 新增
- configs/ 目錄：各 AI 工具的全域強制規則範本
  - CLAUDE.md（Claude Code）
  - AGENTS.md（Codex）
  - GEMINI.md（Gemini CLI）
  - global_rules.md（Windsurf）
  - opencode.json（OpenCode）
- 所有全域規則統一要求：新對話先更新 OwnMind → 再 ownmind_init → 顯示【OwnMind】→ 衝突偵測 → 鐵律防護
- 安裝 prompt 更新為自動掃描並設定所有已安裝的 AI 工具
- IR-008：每次 commit 必須同步更新 README、FILELIST、CHANGELOG

---

## 2026-03-26 — v1.0.0 初版發布

### 核心功能
- API Server（Node.js + Express）上線，部署於 kkvin.com
- PostgreSQL + pgvector 資料庫，支援語意搜尋
- 記憶 CRUD：profile、principle、iron_rule、coding_standard、project、portfolio、env
- 記憶歷史紀錄與回滾功能
- Session log 紀錄，支援分層壓縮
- 交接機制（handoff）：跨工具無縫交接工作
- 密鑰管理：AES-256 加密儲存 API keys 和密碼
- 記憶匯出（JSON 格式）

### MCP Server
- 12 個 MCP tools，供 Claude Code、Cursor 等工具使用
- 預設 API URL 指向 https://kkvin.com/ownmind

### Skill
- ownmind-memory skill：記憶管理的完整操作手冊
- 【OwnMind】品牌標記提示系統
- 【OwnMind 觸發】鐵律主動防護
- 【OwnMind 學習回顧】AI 自我回顧學習成果
- 【OwnMind 衝突】偵測與本地規則的衝突並主動詢問
- 【OwnMind 技巧】28 條隨機小技巧
- 【OwnMind 更新】自動更新檢查並顯示更新內容

### Admin
- Web 管理後台（淺色系介面）
- 帳號密碼登入
- 使用者管理：新增、刪除、複製 API Key
- 安裝 Prompt 產生器：選擇使用者自動帶入 API Key

### 安裝
- 通用安裝 Prompt：AI 自動偵測工具環境並設定
- 支援 Claude Code、Cursor、Codex、Copilot、Windsurf 等
- 一次安裝，全部專案通用
- 自動更新檢查：init 時 git fetch 並自動 pull 新版本

### 部署
- Docker Compose 部署
- nginx reverse proxy（https://kkvin.com/ownmind/）
- port 只綁 localhost，不對外暴露

### 記憶遷移
- 從 USER_RULES.md 遷移：7 條鐵律（IR-001 ~ IR-007）
- 從 PROJECTS_SUMMARY.md 遷移：6 個專案 context
- 遷移 coding standards 和開發環境資訊
