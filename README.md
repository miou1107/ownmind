# OwnMind — 跨平台 AI 個人記憶系統

讓你的 AI 工具共享記憶。不管用 Claude Code、Codex、Cursor、Copilot、Antigravity 還是線上 AI，OwnMind 讓所有工具都能讀寫你的偏好、鐵律、專案 context。

## 核心功能

- **跨平台記憶** — 一個 API，所有 AI 工具共用
- **鐵律管理** — 踩過的坑不會再踩，含完整背景脈絡
- **交接機制** — 在不同工具間無縫交接工作
- **密鑰管理** — 安全儲存 API keys 和密碼
- **語意搜尋** — pgvector 驅動，找到相關記憶
- **分層壓縮** — 短期記憶自動壓縮，長期記憶永久保留
- **持續進化** — AI 主動優化你的工作方法

## 快速開始

### 1. 取得 API Key

聯繫管理員取得你的 API key。

### 2. 安裝

複製以下 prompt，貼到你的 AI 工具（Claude Code、Codex、Cursor 等），把 `YOUR_API_KEY` 換成你的 API key：

```
幫我安裝 OwnMind 個人記憶系統。

我的 API Key 是：YOUR_API_KEY
API URL 是：https://kkvin.com/ownmind

請根據你目前所在的工具環境，自動完成以下安裝：

1. 把 https://github.com/miou1107/ownmind clone 到 ~/.ownmind/（如果已存在就 git pull 更新）
2. 到 ~/.ownmind/mcp/ 執行 npm install

3. 根據你是什麼工具，設定 MCP Server：
   - Claude Code → ~/.claude/settings.json 的 mcpServers
   - Cursor → ~/.cursor/mcp.json 的 mcpServers
   - Windsurf → ~/.codeium/windsurf/mcp_config.json
   - 其他支援 MCP 的工具 → 找到該工具的 MCP 設定檔
   MCP 設定內容：
   {
     "ownmind": {
       "command": "node",
       "args": ["~/.ownmind/mcp/index.js"],
       "env": {
         "OWNMIND_API_URL": "https://kkvin.com/ownmind",
         "OWNMIND_API_KEY": "YOUR_API_KEY"
       }
     }
   }
   （args 裡的 ~ 要展開為完整路徑）

4. 根據你是什麼工具，在對應的指令檔加入 OwnMind 設定：
   - Claude Code → ~/.claude/CLAUDE.md
   - Codex → 專案根目錄的 AGENTS.md
   - Cursor → .cursorrules 或 .cursor/rules
   - Copilot → .github/copilot-instructions.md
   - 其他工具 → 該工具的系統指令設定檔
   加入以下內容（如果還沒有 OwnMind 區塊的話）：
   # OwnMind 個人記憶系統
   你已連接 OwnMind 跨平台 AI 個人記憶系統。
   - 開始工作時，呼叫 ownmind_init 載入使用者記憶
   - 個人偏好、鐵律、專案 context 以 OwnMind 為主要來源
   - 本地 memory 可並存，但發生衝突時以 OwnMind 為準
   - 存取記憶時必須顯示【OwnMind】提示
   - 完成重要工作後，主動儲存記憶
   - 交接工作時，使用 OwnMind 交接機制

5. 如果你的工具支援 skill，把 ~/.ownmind/skills/ownmind-memory.md 安裝到對應的 skill 目錄

6. 檢查本機還有哪些 AI 工具已安裝（檢查 ~/.claude、~/.cursor、~/.codeium 等目錄），一併設定

7. 完成後呼叫 ownmind_init 測試連線，確認能載入記憶
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

### 6. 換一台電腦，記憶跟著走
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
| `project` | 專案 context：架構、環境、進度 |
| `portfolio` | 作品集 |
| `env` | 開發環境資訊 |

## 技術棧

- **Runtime:** Node.js + Express
- **Database:** PostgreSQL + pgvector
- **MCP:** @modelcontextprotocol/sdk
- **部署:** Docker Compose

## License

MIT
