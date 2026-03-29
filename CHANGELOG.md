# OwnMind 更新紀錄

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
