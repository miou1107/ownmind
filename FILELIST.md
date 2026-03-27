# OwnMind 檔案結構

```
OwnMind/
├── README.md                        # 專案說明、應用情境、安裝 prompt
├── FILELIST.md                      # 本檔案 — 檔案結構說明
├── CHANGELOG.md                     # 版本更新紀錄
├── .env.example                     # 環境變數範本
├── .gitignore                       # Git 忽略規則
├── Dockerfile                       # API Server Docker image
├── docker-compose.yml               # Docker Compose 部署設定
├── install.sh                       # 一鍵安裝腳本（Mac / Linux / Git Bash）
├── install.ps1                      # 一鍵安裝腳本（Windows PowerShell 原生）
├── package.json                     # API Server 依賴
│
├── db/
│   └── 001_init.sql                 # PostgreSQL schema（users, memories, handoffs 等 6 張表）
│
├── src/                             # API Server 原始碼
│   ├── app.js                       # Express app 設定、路由掛載
│   ├── index.js                     # Server 啟動入口
│   ├── middleware/
│   │   ├── auth.js                  # API Key 認證中介層
│   │   └── adminAuth.js             # Admin 權限中介層
│   ├── routes/
│   │   ├── memory.js                # 記憶 CRUD + init（含 instructions SOP）
│   │   ├── session.js               # Session log 紀錄
│   │   ├── handoff.js               # 交接機制
│   │   ├── admin.js                 # 使用者管理 + 帳密登入
│   │   ├── secret.js                # 密鑰管理（AES-256 加密）
│   │   └── export.js                # 記憶匯出
│   ├── utils/
│   │   ├── db.js                    # PostgreSQL 連線池
│   │   ├── logger.js                # Winston logger
│   │   ├── crypto.js                # AES-256 加解密工具
│   │   └── syncToken.js             # Sync token 生成與驗證（SHA-256）
│   └── public/
│       └── admin.html               # Admin 管理後台（單頁應用）
│
├── mcp/                             # MCP Server（供 Claude Code、Cursor 等工具使用）
│   ├── index.js                     # MCP Server 入口（12 個 tools）
│   ├── start.cmd                    # Windows 啟動器（動態找 node，供 cmd.exe 呼叫）
│   └── package.json                 # MCP Server 依賴
│
├── hooks/                           # Claude Code PreToolUse hook scripts
│   └── ownmind-iron-rule-check.sh  # 高風險指令前自動顯示相關鐵律（安裝時複製到 ~/.claude/hooks/）
│
├── scripts/                         # 維護工具腳本
│   └── update.sh                    # Auto-update：git pull 後同步 skill、hook 到本機各工具目錄
│
├── configs/                         # 各工具的全域強制規則（安裝時複製到對應位置）
│   ├── CLAUDE.md                    # Claude Code → ~/.claude/CLAUDE.md
│   ├── AGENTS.md                    # Codex → ~/.codex/AGENTS.md
│   ├── GEMINI.md                    # Gemini CLI → ~/.gemini/GEMINI.md
│   ├── global_rules.md              # Windsurf → ~/.codeium/windsurf/memories/global_rules.md
│   ├── opencode.json                # OpenCode → ~/.config/opencode/opencode.json
│   ├── antigravity.md               # Google Antigravity → 全域指令設定
│   ├── copilot-instructions.md      # GitHub Copilot → .github/copilot-instructions.md
│   ├── openclaw.json                # OpenClaw → 合併到 ~/.openclaw/openclaw.json
│   └── openclaw-bootstrap.md       # OpenClaw bootstrap 注入檔（OwnMind 強制規則）
│
├── skills/
│   └── ownmind-memory.md            # OwnMind 記憶管理 Skill
│
└── docs/                            # 各工具設定指南
    ├── setup-claude-code.md
    ├── setup-codex.md
    ├── setup-cursor.md
    ├── setup-copilot.md
    └── setup-online-ai.md
```
