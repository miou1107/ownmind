AI個人化永久記憶解決方案

# OwnMind — 跨平台 AI 個人記憶系統

讓你的 AI 工具共享記憶。不管用 Claude Code、Codex、Cursor、Copilot、Antigravity 還是線上 AI，OwnMind 讓所有工具都能讀寫你的偏好、鐵律、專案 context。

## 最常用的三句話

| 你說 | AI 做什麼 |
|------|----------|
| **「記住了」** | 把經驗寫進鐵律，跨平台永久保存，永不再犯 |
| **「你學到什麼」** | 回顧這次對話，列出值得記下的新知識 |
| **「我最近做了什麼？哪些還沒做？」** | 從所有專案的進度和待辦中回答 |

## 核心功能

- **跨平台記憶** — 一個 API，所有 AI 工具共用
- **鐵律管理** — 踩過的坑不會再犯，含完整背景脈絡
- **規則時間序列** — 規則改變時自動保留舊版本，可追溯演變過程和原因
- **鐵律即時防護** — session 開始時自動載入所有鐵律，AI 在整個工作過程中主動攔截違規
- **Trigger Tags** — 鐵律可標記觸發時機（`trigger:commit`、`trigger:deploy` 等），AI 在該操作前自動 re-check
- **Claude Code Hook** — PreToolUse hook 在 git/deploy/delete 前自動提示相關鐵律，技術層面強制
- **Sync Token** — 多工具同時使用時自動偵測狀態衝突，確保記憶一致性 `v1.8.0`
- **團隊規範** — 管理員統一下發規則，成員自動載入、強制遵守、可 opt-out `v1.8.0`
- **規則品質追蹤** — 自動記錄每條鐵律的遵守/違反/觸發次數，落地率低時主動預警 `v1.8.0`
- **交接機制** — 在不同工具間無縫交接工作
- **密鑰管理** — 安全儲存 API keys 和密碼
- **語意搜尋** — pgvector 驅動，找到相關記憶
- **分層壓縮** — 短期記憶自動壓縮，長期記憶永久保留
- **持續進化** — AI 主動優化你的工作方法
- **Windows 原生支援** — 提供 `install.ps1` 和 `start.cmd`，不需要 Git Bash

## 快速開始

### 1. 取得 API Key

聯繫管理員取得你的 API key。

### 2. 安裝

**Windows 用戶**可以用 PowerShell 直接安裝：
```powershell
irm https://raw.githubusercontent.com/miou1107/ownmind/main/install.ps1 -OutFile install.ps1
.\install.ps1 YOUR_API_KEY
```

**Mac / Linux / Git Bash** 用戶：
```bash
curl -sL https://raw.githubusercontent.com/miou1107/ownmind/main/install.sh | bash -s -- YOUR_API_KEY
```

或者複製以下 prompt，貼到你的 AI 工具（Claude Code、Codex、Cursor 等），把 `YOUR_API_KEY` 換成你的 API key：

```
幫我安裝 OwnMind 個人記憶系統。

我的 API Key 是：YOUR_API_KEY
API URL 是：YOUR_OWNMIND_URL

請根據你目前所在的工具環境，自動完成以下安裝：

Step 1：下載 OwnMind
把 https://github.com/miou1107/ownmind clone 到 ~/.ownmind/（如果已存在就 git pull 更新）
到 ~/.ownmind/mcp/ 執行 npm install

Step 2：設定 MCP Server（如果工具支援）
找到當前工具的 MCP 設定檔，加入 ownmind MCP（~ 展開為完整路徑）：
- Claude Code → ~/.claude/settings.json
- Cursor → ~/.cursor/mcp.json
- Windsurf → ~/.codeium/windsurf/mcp_config.json

Step 3：安裝全域強制規則
掃描本機所有已安裝的 AI 工具，把 ~/.ownmind/configs/ 中對應的設定檔
追加到各工具的全域指令檔（不覆蓋原有內容）：
- Claude Code → ~/.claude/CLAUDE.md（追加 configs/CLAUDE.md）
- Codex → ~/.codex/AGENTS.md（追加 configs/AGENTS.md）
- Gemini CLI → ~/.gemini/GEMINI.md（追加 configs/GEMINI.md）
- Windsurf → ~/.codeium/windsurf/memories/global_rules.md（追加 configs/global_rules.md）
- OpenCode → ~/.config/opencode/opencode.json（合併 configs/opencode.json 的 instructions）

Step 4：安裝 Skill
把 ~/.ownmind/skills/ownmind-memory.md 安裝到工具的 skill 目錄

Step 5：驗證
完成後呼叫 ownmind_init 測試連線，確認能載入記憶並顯示【OwnMind】摘要
```

### 3. 開始使用

安裝完成後，在任何新的對話裡說「載入我的 OwnMind」即可。AI 會自動載入你的記憶。

## 應用情境

### 1. 踩坑後讓 AI 永遠記住
> 你：「記住了，部署前一定要檢查環境變數」

AI 會自動建立一條鐵律，記錄你踩坑的背景和規則。下次不管用哪個工具、哪個 AI，都不會再犯同樣的錯。

### 2. 問 AI 還有什麼事沒做
> 你：「ring 這個專案還有什麼沒做？」

AI 從 OwnMind 調出專案的待辦清單和進度，告訴你哪些做了、哪些還沒。

### 3. 在不同工具間無縫交接
> 你（在 Claude Code）：「整理一下，交接給 Codex」

AI 把目前進度、待辦、注意事項整理好存到 OwnMind。你切到 Codex 開新對話，AI 自動讀取交接內容，無縫接手。

### 4. 讓 AI 自我回顧學到什麼
> 你：「你今天學到什麼？」

AI 回顧整個對話，列出所有還沒記下來的新知識和發現，問你哪些要存進 OwnMind。

### 5. AI 主動攔截你踩過的坑
> AI 正準備用多次 SSH 連線部署...
>
> 【OwnMind 觸發】你提醒過「SSH 不要頻繁登入登出」，我要遵守，不能再犯

AI 在即將違反鐵律的那一刻主動停下來，不用你提醒。

### 6. 多工具同時用，記憶不打架
> 你同時在 Claude Code 和 Cursor 工作，兩邊都在寫記憶...
>
> 【OwnMind】偵測到狀態已變更，正在 re-init 取得最新記憶...

Sync Token 機制自動偵測衝突。寫入前驗證 token，過期就先同步再寫，不會互相覆蓋。

### 7. 團隊共用規範，一人設定全員生效
> 管理員：「新增團隊規範：所有 API 回傳必須包含 request_id」
>
> 【OwnMind】⚠️ 你即將新增團隊規範，此規範將套用到所有成員。請輸入「我確認」。

團隊規範由管理員統一下發，成員開新對話自動載入，違反時強制提醒。個人可 opt-out 但會持續提醒。

### 8. 規則有沒有在遵守？數據說話
> 你：「我的鐵律遵守狀況如何？」
>
> 【OwnMind】規則自評：IR-001 SSH 規則 — 遵守 12 次，觸發 3 次，遺漏 0 次（落地率 100%）

每條鐵律自動追蹤 enforced/missed/triggered 計數，落地率低的規則會主動預警。

### 9. 換一台電腦，記憶跟著走
> 你（在新電腦）：「幫我安裝 OwnMind，API Key 是 xxx」

AI 自動完成安裝設定，你的所有偏好、鐵律、專案 context 立刻可用，不用重新教。

## API 文件

### 認證
所有 API 請求需要在 header 加入：
```
Authorization: Bearer YOUR_API_KEY
```

### 主要 Endpoints

| Endpoint | 說明 |
|----------|------|
| `GET /api/memory/init` | 載入記憶（profile + principles + instructions） |
| `GET /api/memory/type/:type` | 取得特定類型記憶 |
| `GET /api/memory/search?q=` | 語意搜尋 |
| `POST /api/memory` | 新增記憶 |
| `PUT /api/memory/:id` | 更新記憶 |
| `PUT /api/memory/:id/disable` | 停用記憶 |
| `POST /api/handoff` | 建立交接 |
| `GET /api/handoff/pending` | 取得待接手的交接 |
| `POST /api/session` | 記錄 session |
| `GET /api/export` | 匯出所有記憶 |
| `GET /health` | 健康檢查 |

### 記憶類型

| 類型 | 說明 |
|------|------|
| `profile` | 個人檔案：身份、溝通偏好、工作風格 |
| `principle` | 核心原則與願景 |
| `iron_rule` | 鐵律：踩坑後訂下的不可違反規則 |
| `coding_standard` | 技術偏好與編碼標準 |
| `team_standard` | 團隊規範：管理員下發，全員共享 |
| `project` | 專案 context：架構、環境、進度 |
| `portfolio` | 作品集 |
| `env` | 開發環境資訊 |

## 技術棧

- **Runtime:** Node.js + Express
- **Database:** PostgreSQL + pgvector
- **MCP:** @modelcontextprotocol/sdk
- **部署:** Docker Compose

## Contributors

- Vin (miou1107)

## License

MIT
