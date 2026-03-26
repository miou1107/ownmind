# OwnMind 更新紀錄

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
