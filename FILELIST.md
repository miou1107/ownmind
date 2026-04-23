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
│   ├── 001_init.sql                 # PostgreSQL schema（users, memories, handoffs 等 6 張表）
│   ├── 002_add_team_standard.sql    # 團隊規範相關 migration
│   ├── 003_activity_logs.sql        # Activity logs 表（事件追蹤）
│   ├── 004_weekly_summary_marker.sql # users.weekly_summary_sent_at（週摘要 marker）
│   ├── 005_admin_roles_password.sql  # password_hash、super_admin 角色、audit_logs 表
│   ├── 006_add_standard_detail.sql   # memories type 加上 standard_detail
│   ├── 007_token_usage.sql           # Token 用量追蹤 7 張表 + 初始 model pricing
│   └── 008_broadcast.sql             # v1.17.0 — broadcast_messages / user_broadcast_state / user_tool_last_seen / memories.is_test
│
├── src/                             # API Server 原始碼
│   ├── app.js                       # Express app 設定、路由掛載
│   ├── constants.js                 # 共用常數（ALLOWED_MEMORY_TYPES）
│   ├── index.js                     # Server 啟動入口
│   ├── middleware/
│   │   ├── auth.js                  # API Key 認證中介層
│   │   └── adminAuth.js             # Admin 權限中介層（含 superAdminAuth + isAtLeast）
│   ├── routes/
│   │   ├── memory.js                # 記憶 CRUD + init（含 instructions SOP）
│   │   ├── session.js               # Session log 紀錄
│   │   ├── handoff.js               # 交接機制
│   │   ├── admin.js                 # 使用者管理 + 帳密登入 + 角色控管 + 稽核
│   │   ├── secret.js                # 密鑰管理（AES-256 加密）
│   │   ├── export.js                # 記憶匯出
│   │   ├── activity.js              # Activity log batch upload + 統計 API
│   │   └── usage/                   # Token 用量追蹤 API（P1 起）
│   │       ├── index.js             # 掛載 /api/usage/* 子路由
│   │       ├── pricing.js           # GET 所有 model pricing；POST 新增（super_admin only, append-only）
│   │       ├── events.js            # POST raw events（exempt check / codex fingerprint / heartbeat / D7 / dedupe / trigger aggregation）
│   │       ├── stats.js             # GET 個人 stats（from / to / group_by=day|tool|model|session）
│   │       ├── exemptions.js        # GET / POST / DELETE usage_tracking_exemption（super_admin only）
│   │       ├── admin-audit.js       # GET usage_audit_log（admin+；可 filter event_type / user_id）
│   │       ├── admin-clients.js     # v1.17.0 — GET 裝機狀況（admin+；per user+tool heartbeat + needs_upgrade + coverage）
│   │       └── team-stats.js        # GET 團隊 coverage + 逐 user 總計（admin+，spec D5）
│   │   └── broadcast.js             # v1.17.0 P2 — 廣播系統（admin CRUD + user active/dismiss + snooze）
│   ├── lib/
│   │   └── broadcast-filter.js      # v1.17.0 P2 — filterVisibleBroadcasts / filterInjectable（P2 + P4 共用）
│   ├── utils/
│   │   ├── db.js                    # PostgreSQL 連線池
│   │   ├── logger.js                # Winston logger
│   │   ├── crypto.js                # AES-256 加解密工具
│   │   ├── syncToken.js             # Sync token 生成與驗證（SHA-256）
│   │   ├── report.js               # 週/月報計算純函式（computePeriodRange, groupFrictions）
│   │   ├── enforcement.js          # Enforcement alerts 計算純函式
│   │   ├── templates.js            # 規則模板庫 + 自動匹配
│   │   ├── auto-numbering.js       # Iron rule 自動編號（generateNextIronRuleCode）
│   │   ├── pricing-lookup.js       # Token 定價查找（pickPricing / computeCost / lookupPricing）
│   │   └── semver.js               # v1.17.0 — parseSemver / compareSemver / isLower / isHigher（version 比對共用）
│   ├── jobs/
│   │   ├── weeklyReport.js          # 週/月報 cron job（node-cron）
│   │   ├── usage-aggregation.js     # token_events → token_usage_daily 重算（純函式 + recomputeDaily）
│   │   ├── nightly-recompute.js     # 每日 03:00 Asia/Taipei 跑近 7 天完整 recompute
│   │   └── nightly-upgrade-reminder.js  # v1.17.0 P2 — 每日 03:30 冪等產生 upgrade_reminder 廣播
│   └── public/
│       └── index.html               # Admin 管理後台（單頁應用）
│
├── mcp/                             # MCP Server（供 Claude Code、Cursor 等工具使用）
│   ├── index.js                     # MCP Server 入口（13 個 tools）+ 啟動時自動更新
│   ├── offline.js                   # Offline resilience helpers（local cache read/write, write queue, local search）
│   ├── ownmind-log.js               # Activity log 模組（本地 JSONL + server batch upload）
│   ├── start.cmd                    # Windows 啟動器（動態找 node，供 cmd.exe 呼叫）
│   └── package.json                 # MCP Server 依賴
│
├── shared/
│   ├── verification.js              # Verification Engine 核心（純函式）
│   ├── helpers.js                   # 共用工具函式（readJsonSafe、getChangedSourceFiles、readCredentials、trigger detection）
│   ├── compliance.js                # 統一 compliance log schema 讀寫
│   └── scanners/
│       ├── id-helper.js             # Codex 專用 fingerprint（canonicalize + sha256 message_id；client+server 共用）
│       ├── base.js                  # Scanner orchestrator：runScan / atomic offsets / batching（P4）
│       ├── claude-code.js           # Claude Code JSONL adapter（session cumulative running total、byte_offset cursor）
│       ├── codex.js                 # Codex JSONL adapter（event_msg/token_count → canonical material → message_id）
│       ├── opencode.js              # OpenCode SQLite adapter（sqlite3 CLI、composite (time_created, id) cursor）
│       ├── vscode-telemetry.js      # Cursor/Antigravity 共用 helper（state.vscdb 讀取 + Taipei Ymd + 通用 adapter 工廠）
│       ├── cursor.js                # Cursor Tier 2 adapter（session_count only）
│       └── antigravity.js           # Antigravity Tier 2 adapter（session_count only）
│
├── hooks/                           # Claude Code hook scripts（安裝時複製到 ~/.claude/hooks/）
│   ├── package.json                 # ESM module declaration（type: module）
│   ├── ownmind-session-start.sh    # SessionStart hook：自動載入記憶 + 每日自動更新（bash 版）
│   ├── ownmind-session-start.js    # SessionStart hook（L4）：ESM，載入初始記憶並顯示鐵律摘要
│   ├── ownmind-iron-rule-check.sh  # PreToolUse hook：高風險指令前自動顯示相關鐵律（bash 版）
│   ├── ownmind-iron-rule-check.js  # PreToolUse hook（L2）：ESM，commit/deploy/delete 都跑 verification blocking
│   ├── ownmind-worktree-setup.sh   # WorktreeCreate hook：worktree 自動注入 .mcp.json
│   ├── ownmind-git-pre-commit.js   # git pre-commit hook (L1)
│   ├── ownmind-git-post-commit.js  # git post-commit hook (L5)
│   ├── ownmind-git-pre-commit      # pre-commit shell wrapper
│   ├── ownmind-git-post-commit     # post-commit shell wrapper
│   ├── ownmind-verify-trigger.js   # deploy/delete 驗證輔助腳本
│   ├── ownmind-usage-scanner.js    # Token 用量 scanner 主 entry（P4；P6 由 launchd/systemd 每 30 分鐘呼叫）
│   └── lib/                        # v1.17.0 P3 — hook 共用純函式
│       ├── render-session-context.js   # renderSessionContext(data, broadcasts) → additionalContext 字串
│       └── session-start-output.js     # Node CLI wrapper，讓 bash hook 呼叫
│
├── scripts/                         # 維護工具腳本
│   ├── bootstrap.sh                 # v1.17.6 — Universal Bootstrap（Mac/Linux/Git Bash）：三分支處理 install/upgrade/repair
│   ├── bootstrap.ps1                # v1.17.6 — Universal Bootstrap（Windows PowerShell）：同上
│   ├── update.sh                    # Auto-update：同步 skill、hooks、settings 到所有 AI 工具
│   ├── check-sync.sh                # v1.17.2 — 三層 drift 健檢（L1 git / L2 server version / L3 deploy diff）
│   ├── migrate-verification.js      # 鐵律 verification 一次性遷移
│   ├── install-helpers/
│   │   └── run-scanner.sh           # Usage scanner wrapper：動態找 node + v20+ 驗證（D12）
│   ├── launchd/
│   │   └── com.ownmind.usage-scanner.plist  # macOS launchd agent（30 分鐘 + RunAtLoad）
│   ├── systemd/
│   │   ├── ownmind-usage-scanner.service    # Linux user service（oneshot）
│   │   └── ownmind-usage-scanner.timer      # Linux user timer（開機 5 分鐘 + 每 30 分鐘）
│   └── windows/
│       └── register-scanner-task.ps1        # Windows Task Scheduler 註冊腳本
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
├── tests/
│   ├── report.test.js               # report.js 單元測試（node:test）
│   ├── enforcement.test.js          # enforcement.js 單元測試
│   ├── verification.test.js         # Verification Engine 測試
│   ├── templates.test.js            # 模板匹配測試
│   ├── helpers.test.js              # shared/helpers.js 單元測試
│   ├── compliance.test.js           # shared/compliance.js 單元測試
│   ├── trigger-detection.test.js    # 觸發檢測精準度測試
│   ├── pricing.test.js              # pricing-lookup.js 單元測試（effective_date / cost 計算）
│   ├── aggregation.test.js          # usage-aggregation.js 單元 + recomputeDaily integration
│   ├── ingestion.test.js            # events.js validation / dedupe / audit / codex / heartbeat / exempt
│   ├── fingerprint.test.js          # shared/scanners/id-helper.js（canonicalize + sha256 deterministic）
│   ├── exemptions.test.js           # exemptions route CRUD + audit
│   ├── scanner-base.test.js         # base.js：chunk / mergeState / atomic offsets / runScan
│   ├── scanner-claude-code.test.js  # claude-code adapter：fixture parse / cumulative / crash-resume / replay safety
│   ├── scanner-lock.test.js         # acquireLock：live PID / stale PID / 6h mtime 接手
│   ├── scanner-codex.test.js        # codex adapter：token_count → material → message_id / compact / byte_offset cursor
│   ├── scanner-opencode.test.js     # opencode adapter：composite cursor / interleaved sessions / SQL escape
│   ├── run-scanner-wrapper.test.js  # wrapper shell script：候選選擇 / version 檢查 / error 路徑（spawn bash）
│   ├── scanner-cursor-antigravity.test.js  # Tier 2 adapter（state.vscdb + Taipei Ymd + session record emit 規則）
│   ├── team-stats.test.js           # /api/usage/team-stats coverage + users aggregate + 角色驗證
│   ├── stats.test.js                # /api/usage/stats totals / series / Tier-2 merge / null-cost policy
│   ├── clients.test.js              # v1.17.0 — /api/usage/admin/clients（auth / status / upgrade / multi-tool / coverage / pre-release）
│   ├── semver.test.js               # v1.17.0 — parseSemver / compareSemver（pre-release / build metadata / malformed）
│   ├── broadcast.test.js            # v1.17.0 P2 — validate / CRUD / snooze / filter / cooldown / nightly job（46 tests）
│   ├── session-start-render.test.js # v1.17.0 P3 — renderSessionContext（broadcasts + memory）
│   ├── mcp-startup-heartbeat.test.js # MCP 啟動時自動觸發 heartbeat 的靜態檢查（v1.17.4）
│   ├── heartbeat-once-per-process.test.js # Heartbeat 每個 MCP process 最多發一次（client 端 crash-loop 保護，v1.17.5）
│   ├── heartbeat-rate-limit.test.js  # Heartbeat UPSERT 30 秒內為 no-op（server 端 rate-limit，v1.17.5）
│   ├── bootstrap-script.test.js     # Universal bootstrap 腳本靜態檢查（三分支 / +x bit / logging / curl-pipe 安全，v1.17.6）
│   └── bootstrap-routes.test.js     # Express public routes 整合測試（GET /bootstrap.sh / .ps1 無 auth 正常回應，v1.17.6）
│
└── docs/                            # 文件 + 多語系 README
    ├── README.zh-TW.md              # 繁體中文 README
    ├── README.ja.md                 # 日文 README
    ├── setup-claude-code.md
    ├── setup-codex.md
    ├── setup-cursor.md
    ├── setup-copilot.md
    ├── setup-online-ai.md
    └── superpowers/
        └── plans/
            └── 2026-04-23-mcp-startup-heartbeat.md  # v1.17.4 MCP 啟動 heartbeat 實作計畫
```
