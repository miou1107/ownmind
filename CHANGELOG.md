# OwnMind 更新紀錄

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
