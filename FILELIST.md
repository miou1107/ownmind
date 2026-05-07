# OwnMind 檔案結構

```
OwnMind/
├── README.md                        # 專案說明、應用情境、安裝 prompt
├── FILELIST.md                      # 本檔案 — 檔案結構說明
├── CHANGELOG.md                     # 版本更新紀錄
├── .env.example                     # 環境變數範本
├── .gitattributes                   # 強制 hook / shell scripts 用 LF 行尾（防 Windows core.autocrlf 把 sh script 轉 CRLF 導致 Exec format error）
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
│   │   ├── broadcast-filter.js      # v1.17.0 P2 — filterVisibleBroadcasts / filterInjectable（P2 + P4 共用）
│   │   ├── memory-sync.js           # v1.17.8 — delta sync 純函式（parseSyncTypes / parseSince / buildSyncQuery）
│   │   └── session-query.js         # v1.17.13 — buildSessionRecentQuery 純函式（含 ?q= search）
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
│   ├── ownmind-git-commit-msg      # commit-msg shell wrapper（IR-024 阻擋 Co-Authored-By）
│   ├── ownmind-verify-trigger.js   # deploy/delete 驗證輔助腳本
│   ├── ownmind-usage-scanner.js    # Token 用量 scanner 主 entry（P4；P6 由 launchd/systemd 每 30 分鐘呼叫）
│   └── lib/                        # v1.17.0 P3 — hook 共用純函式
│       ├── render-session-context.js   # renderSessionContext(data, broadcasts) → additionalContext 字串
│       ├── session-start-output.js     # Node CLI wrapper，讓 bash hook 呼叫
│       └── sync-memory-files.js        # v1.17.8 — 雲端 → 本地 md 檔 delta sync（stdin JSON / --fail mode）
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
│   ├── bootstrap-routes.test.js     # Express public routes 整合測試（GET /bootstrap.sh / .ps1 無 auth 正常回應，v1.17.6）
│   ├── tip-every-call.test.js       # MCP 技巧提示每次都顯示（移除 tipCallCount % 10 gating，v1.17.7）
│   ├── memory-sync-endpoint.test.js # v1.17.8 — /api/memory/sync 參數解析 + SQL builder（16 tests）
│   ├── sync-memory-files.test.js    # v1.17.8 — 本地 md 同步 / tombstone / fail mode / backup（22 tests）
│   ├── ps1-utf8-bom.test.js         # v1.17.9 — 所有 .ps1 必須 UTF-8 BOM（Eric case）
│   ├── ps1-windows-compat.test.js   # v1.17.9 — .ps1 環境正規化 preamble + install flag 過濾（Adam case）
│   ├── install-ps1-copy-safety.test.js  # v1.17.10 — install.ps1 Copy-Item self-overwrite guard
│   ├── scheduled-task-duration.test.js  # v1.17.10 — Task Scheduler Duration 不能用 TimeSpan.MaxValue
│   ├── bootstrap-strip-bom.test.js  # v1.17.10 — bootstrap public route strip BOM（iwr|iex 相容）
│   ├── credentials-bom-safe.test.js # v1.17.12 — readCredentials / readJsonSafe 容忍 BOM-prefixed JSON
│   ├── install-ps1-no-bom-outputs.test.js # v1.17.12 — install.ps1 禁用 Set-Content 寫敏感檔
│   ├── install-ps1-scanner-task-check.test.js # v1.17.12 — install.ps1 驗證 scanner task 真的註冊
│   ├── session-recent-query.test.js # v1.17.13 — buildSessionRecentQuery 含 q= search 支援
│   ├── tier2-windows-fix.test.js    # v1.17.14 — Tier 2 Windows 支援（opencode win32 + sqlite3 偵測）
│   ├── p3-update-event-semantics.test.js # v1.17.16 — update_ok 假陽性 fix（Adam case；mcp/index.js + hook 對偶；11 tests）
│   ├── team-overview-api.test.js         # v1.17.17 — 鐵律遵守率算法、票選專案、scoreboard endpoint（16 cases）
│   └── team-overview-sessions-api.test.js # v1.17.17 — sessions endpoint、machine_meta fallback、limit 邊界（7 cases）
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
        ├── plans/
        │   ├── 2026-04-23-mcp-startup-heartbeat.md  # v1.17.4 MCP 啟動 heartbeat 實作計畫
        │   └── 2026-04-28-dashboard-team-overview.md  # v1.17.17 Dashboard 團隊一覽改造計畫
        └── specs/
            └── 2026-04-28-dashboard-team-overview-design.md  # v1.17.17 Dashboard 團隊一覽設計 spec
```

## v1.17.17 新增 / 修改

新增檔案：

```
src/routes/usage/team-overview.js         — 團隊一覽 admin API（scoreboard + sessions timeline）
db/009_collector_heartbeat_os.sql         — collector_heartbeat 加 os 欄位 migration
tests/team-overview-api.test.js           — 團隊一覽 scoreboard 單元測試（16 cases）
tests/team-overview-sessions-api.test.js  — 團隊一覽 sessions 單元測試（7 cases）
docs/superpowers/specs/2026-04-28-dashboard-team-overview-design.md
docs/superpowers/plans/2026-04-28-dashboard-team-overview.md
```

修改的既有檔：

```
src/routes/usage/events.js   — heartbeat UPSERT 補 os 欄位
src/routes/usage/index.js    — mount team-overview router
mcp/index.js                 — heartbeat 加 os: os.platform()
src/public/index.html        — 表格擴欄 / 最近對話區 / Audit Log 改名為「資料品質警示」
```

## v1.17.18 修改（broadcast-version-filter handoff）

修改的既有檔：

```
hooks/ownmind-session-start.sh        — 呼叫 /broadcast/active 時帶 client_version + X-Ownmind-Version
mcp/index.js                          — fetchBroadcastsSafely 改用 CLIENT_VERSION（不再依賴未設定的 env var）
scripts/interactive-upgrade.sh        — OK:done 之前自動 dismiss type=upgrade_reminder 廣播
scripts/interactive-upgrade.ps1       — 同上，PowerShell 版
skills/ownmind-upgrade.md             — 移除「Step 3：AI 手動 dismiss」段落，改成「腳本自動處理」
tests/broadcast.test.js               — 新增 2 個 /broadcast/active route 的 client_version regression case
package.json / docs/README*           — 1.17.17 → 1.17.18，三語系同步
CHANGELOG.md                          — v1.17.18 條目
```

## v1.17.19 修改（project_281 backlog item C — LOCK_FILE touch fail handling）

修改的既有檔：

```
mcp/index.js                              — touch "${LOCK_FILE}" 加 || echo __OM_LOCK_FAIL__ + failMarkers 補入
hooks/ownmind-session-start.sh            — touch "$LOCK_FILE" 加 || log_event update_failed step=lock
tests/p3-update-event-semantics.test.js   — 新增 3 個 P3-lock regression case
package.json / docs/README*               — 1.17.18 → 1.17.19，三語系同步
CHANGELOG.md                              — v1.17.19 條目
```

## v1.17.20 新增 / 修改（admin 工作紀錄頁）

新增檔：

```
src/routes/admin-work-log.js              — GET /api/admin/work-log + /filters，三來源 UNION ALL
tests/admin-work-log.test.js              — 9 case 涵蓋權限/SQL/篩選/limit cap/total
```

修改既有：

```
src/app.js                                — mount /api/admin/work-log（在 /api/admin 之前）
src/public/index.html                     — 新「工作紀錄」tab + JS loader；資料品質警示 card 加 hidden
package.json / docs/README*               — 1.17.19 → 1.17.20，三語系同步
CHANGELOG.md                              — v1.17.20 條目
```

## v1.17.21 修改（compact mode 砍掉合規回報指令的回灌）

新增檔：

```
tests/init-compact-compliance-instruction.test.js  — 3 case 防退化
```

修改既有：

```
src/routes/memory.js                         — ironRulesDigestFinal 末尾固定加合規回報指令
package.json / docs/README*                  — 1.17.20 → 1.17.21，三語系同步
CHANGELOG.md                                 — v1.17.21 條目
```

## v1.17.22 新增 / 修改（Windows MCP auto-update silent-skip 修補）

新增檔：

```
scripts/update.ps1                                — update.sh 的 PowerShell 版（含 UTF-8 BOM）
tests/mcp-auto-update-cross-platform.test.js      — 8 case 跨平台 reproduction
```

修改既有：

```
mcp/index.js                              — 整段 auto-update 重構：os.homedir() + Node-native execFile
                                            + update_skipped 觀測 event
tests/p3-update-event-semantics.test.js   — 既有 P3 / P3-lock 測試對齊 Node-native 新架構
package.json / docs/README*               — 1.17.21 → 1.17.22，三語系同步
CHANGELOG.md                              — v1.17.22 條目
```

## v1.17.23 修改（Codex review 後續修補 5 項）

修改既有：

```
mcp/index.js                              — atomic lock (openSync wx) + git pull --autostash
                                            + 外層 catch log update_failed step=outer
scripts/update.ps1                        — argv[2]/[3] 修正 + 補 Gemini/Copilot/Cursor hooks
tests/mcp-auto-update-cross-platform.test.js  — 新增 5 case 對應 Codex review findings
tests/p3-update-event-semantics.test.js   — P3-lock test 對齊 openSync wx 新架構
package.json / docs/README*               — 1.17.22 → 1.17.23，三語系同步
CHANGELOG.md                              — v1.17.23 條目
```

## v1.17.24 新增 / 修改（用戶用量報告頁）

新增檔：

```
src/routes/me.js                          — /api/me/profile + /api/me/report endpoint
src/public/me/index.html                  — 用戶端自助登入 + 三 tab 報告 UI
tests/me-report.test.js                   — 7 case 防退化
```

修改既有：

```
src/app.js                                — 掛 /api/me 路由 + /me 靜態頁
package.json / docs/README*               — 1.17.23 → 1.17.24，三語系同步
CHANGELOG.md                              — v1.17.24 條目
```

## v1.17.25 新增 / 修改（user role 改成帳密登入）

新增檔：

```
db/010_user_password_login.sql            — must_change_password 欄位 + email 索引
src/jobs/seed-default-passwords.js        — boot 時補預設密碼（idempotent）
```

修改既有：

```
src/routes/me.js                          — 加 POST /login + /change-password；/profile 多回 must_change_password
src/public/me/index.html                  — Email/password 登入；強制首次改密碼 UI
src/index.js                              — boot 時呼叫 seedDefaultPasswords()
tests/me-report.test.js                   — 新增 6 case
package.json / docs/README*               — 1.17.24 → 1.17.25，三語系同步
CHANGELOG.md                              — v1.17.25 條目
```

## v1.17.26 修改（admin 建 user 自動套預設密碼）

修改既有：

```
src/routes/admin.js                       — POST /users 對 user role 無密碼時套
                                            DEFAULT_USER_PASSWORD + must_change_password=TRUE
tests/me-report.test.js                   — 新增 1 case
package.json / docs/README*               — 1.17.25 → 1.17.26，三語系同步
CHANGELOG.md                              — v1.17.26 條目
```

## v1.17.27 修改（hotfix /ownmind/me/ API path）

```
src/public/me/index.html                  — fetch path 從 /api/me/ 改 /ownmind/api/me/
package.json / docs/README*               — 1.17.26 → 1.17.27
CHANGELOG.md                              — v1.17.27 條目
```

## v1.17.28 修改（hotfix bar chart CSS）

```
src/public/me/index.html                  — .bar-row / .bar / .bar-label CSS 重寫
package.json / docs/README*               — 1.17.27 → 1.17.28
CHANGELOG.md                              — v1.17.28 條目
```

## v1.17.29 修改（bar chart 數字標籤）

```
src/public/me/index.html                  — barChart 加 .bar-value 顯示數值
package.json / docs/README*               — 1.17.28 → 1.17.29
CHANGELOG.md                              — v1.17.29 條目
```

## v1.17.30 修改（bar chart 平均線 + 專案主要貢獻者拆分）

```
src/routes/me.js                          — projects 改回 contributors[{name,sessions,turns}]
src/public/me/index.html                  — barChart 加平均線；專案表加「主要負責人」「其他貢獻者」欄
package.json / docs/README*               — 1.17.29 → 1.17.30
CHANGELOG.md                              — v1.17.30 條目
```

## v1.17.31 修改（其他貢獻者門檻過濾）

```
src/public/me/index.html                  — 加 max(20輪, 10% 專案總輪次) 門檻過濾偶發測試
package.json / docs/README*               — 1.17.30 → 1.17.31
CHANGELOG.md                              — v1.17.31 條目
```

## v1.17.32 修改（個人 tab：活動紀錄 + 鐵律完整列表 + 遵守率）

```
src/routes/me.js                          — me.compliance LEFT JOIN 全鐵律；新增 me.activity 200 筆
src/public/me/index.html                  — 個人 tab 加活動紀錄表 + 鐵律加遵守率欄
package.json / docs/README*               — 1.17.31 → 1.17.32
CHANGELOG.md                              — v1.17.32 條目
```

## v1.17.33 修改（鐵律/活動紀錄分頁）

```
src/routes/me.js                          — me.activity 移除 LIMIT 200
src/public/me/index.html                  — 加 paginate / renderPager helper、CSS .pager
package.json / docs/README*               — 1.17.32 → 1.17.33
CHANGELOG.md                              — v1.17.33 條目
```

## v1.17.34 修改（自訂日期範圍 + 專案大小寫合併）

```
src/routes/me.js                          — 加 start/end 參數 + LOWER(TRIM) 專案 group key
src/public/me/index.html                  — range select 加「自訂…」 + date inputs + 套用按鈕
package.json / docs/README*               — 1.17.33 → 1.17.34
CHANGELOG.md                              — v1.17.34 條目
```

## v1.17.35 修改（團隊趨勢圖切換 metric）

```
src/routes/me.js                          — team.users + 3 trend charts 加 tokens/turns（FULL OUTER JOIN）
src/public/me/index.html                  — 加 metricSel 下拉、users 表加 Token/輪次 欄、barChart 加 fmtBig
package.json / docs/README*               — 1.17.34 → 1.17.35
CHANGELOG.md                              — v1.17.35 條目
```

## v1.17.36 修改（專案來源加 handoffs）

```
src/routes/me.js                          — projectHandoffQ 補 handoffs 進 projMap，含 my_handoffs
src/public/me/index.html                  — 專案表加「交接」欄；只交接無 session_log 顯示「N 次交接」
package.json / docs/README*               — 1.17.35 → 1.17.36
CHANGELOG.md                              — v1.17.36 條目
```

## v1.17.37 修改（auto-write session_log 帶 project + 多 signal 全收）

```
mcp/index.js                              — AUTO_PROJECT 從 CLAUDE_PROJECT_DIR 偵測；
                                            emergencySessionLog 寫 project + duration_turns；
                                            訂 SIGTERM/SIGINT/SIGHUP/SIGQUIT 全部 + process.on('exit') 保險
package.json / docs/README*               — 1.17.36 → 1.17.37
CHANGELOG.md                              — v1.17.37 條目
```

## v1.17.38 修改（5 個 server-side 反向稽核）

```
src/routes/me.js                          — 5 個 audit query + me.audit_findings 回傳結構
src/public/me/index.html                  — #audit-findings 卡片區、CSS .audit-card 三色
package.json / docs/README*               — 1.17.37 → 1.17.38
CHANGELOG.md                              — v1.17.38 條目
```

## v1.17.39 修改（Codex round 3 audit 全面修補）

```
src/routes/me.js                          — P1.1 orphan_session 日期 gate; P1.2 compliance_gap
                                            縮窄事件; P2.1 heartbeat LOWER 比對; P2.2 high
                                            findings 寫 audit_logs; P3 blind_spot + team_blindspot
src/public/me/index.html                  — 加 unobservable_source / team_blindspot label
package.json / docs/README*               — 1.17.38 → 1.17.39
CHANGELOG.md                              — v1.17.39 條目
```

## v1.17.40 修改（compliance call 系統強制）

```
mcp/index.js                              — 加 autoComplyForToolCall()，CallToolRequestSchema
                                            handler 成功後自動 emit iron_rule_compliance
                                            event（source='system_auto'）
package.json / docs/README*               — 1.17.39 → 1.17.40
CHANGELOG.md                              — v1.17.40 條目
```

## v1.17.41 修改（Codex round 4 後 auto-compliance 誠信修補）

```
mcp/index.js                              — autoComplyForToolCall：action 改 'observed_trigger'
                                            移除 handoff IR-008/009/024 over-extrapolation
                                            加 dedup set + 補 appendCompliance()
                                            移除 silent catch 改 console.error
src/routes/me.js                          — compliance query 排除 system_auto 於 comply 計數，
                                            加獨立 observed 欄位
src/public/me/index.html                  — 鐵律表多「系統觀測」欄、遵守率只算 AI 自報
package.json / docs/README*               — 1.17.40 → 1.17.41
CHANGELOG.md                              — v1.17.41 條目
```

## v1.17.42 修改（compliance gap 拆兩等級）

```
src/routes/me.js                          — complianceGapQ 拆 gap_unobserved / gap_unverified
                                            兩種 finding type 不同 severity
src/public/me/index.html                  — TYPE_LABEL 加 compliance_unobserved/unverified
package.json / docs/README*               — 1.17.41 → 1.17.42
CHANGELOG.md                              — v1.17.42 條目
```

## v1.17.43 修改（gap rule_code 關聯 + 文案中性化）

```
src/routes/me.js                          — sensitive CTE 加 expected_rules 陣列
                                            has_matching_manual_comply 加 rule_code = ANY 比對
                                            unverified 訊息改成中性描述
package.json / docs/README*               — 1.17.42 → 1.17.43
CHANGELOG.md                              — v1.17.43 條目
```

## v1.17.44 修改（前端 unverified label 對齊）

```
src/public/me/index.html                  — TYPE_LABEL.compliance_unverified 改中性文案
package.json / docs/README*               — 1.17.43 → 1.17.44
CHANGELOG.md                              — v1.17.44 條目
```

## v1.17.45 修改（自動觀測搬到伺服器端）

```
src/routes/activity.js                    — 新增 autoEmitObservedTrigger()，
                                            POST /batch 收到 memory_disable / save / update
                                            (iron_rule) 自動補 observed_trigger
                                            source='system_server_auto'
src/routes/me.js                          — gap audit 跟 compliance 統計 source 比對
                                            從 != 'system_auto' 改成 NOT LIKE 'system_%'
package.json / docs/README*               — 1.17.44 → 1.17.45
CHANGELOG.md                              — v1.17.45 條目
```

## v1.17.46 修改（/me 專案排行 UI 精簡）

```
src/public/me/index.html                  — 移除「我的份」欄（header + cell + desc）
                                            移除「N 位偶發測試略過」註記
src/routes/me.js                          — 清掉 my_sessions / my_handoffs 累計欄位
package.json / README* / docs/README*     — 1.17.45 → 1.17.46
CHANGELOG.md                              — v1.17.46 條目
```

## v1.17.62 修改（修自動更新兩個 silent fail）

```
mcp/index.js                              — execFile(NPM_CMD,...) 加 shell: IS_WINDOWS（修 Adam Windows EINVAL）
                                            update_applied 後重發心跳、讀 disk package.json 新版號
                                            （修 Michelle 長跑 MCP cached 舊版回報）
package.json                              — 1.17.61 → 1.17.62
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.61 → 1.17.62
CHANGELOG.md                              — v1.17.62 條目
```

## v1.17.61 修改（/me 報告頁加 MCP 通道盲點提示）

```
src/public/me/index.html                  — 新增 .blindspot-notice CSS + main 最上方固定提示元素
package.json                              — 1.17.60 → 1.17.61
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.60 → 1.17.61
CHANGELOG.md                              — v1.17.61 條目
```

## v1.17.60 修改（settings.json 安全讀取 + 自動更新 lock 旗標）

```
scripts/install-helpers/load-settings-safe.cjs   — 新增（loadOrSkip helper：壞掉印警告 + exit(0)，原檔不洗掉）
scripts/update.sh                                — 4 處 node -e 改用 loadOrSkip（Claude / Gemini / Copilot / Cursor）
scripts/update.ps1                               — 對應 4 處 node 腳本改用 loadOrSkip
mcp/index.js                                     — 加 module-scope _lockHeld 旗標；外層 catch 只在自己持有時 cleanup
tests/load-settings-safe.test.js                 — 新增（7 case：missing / valid / corrupt-no-overwrite / caller-write-also-no-clobber / non-object JSON / empty file / unreadable）
package.json                                     — 1.17.59 → 1.17.60
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.59 → 1.17.60
CHANGELOG.md                                     — v1.17.60 條目
```

## v1.17.59 修改（mcp/index.js 三項硬化）

```
shared/helpers.js                         — 加 sanitizeErrorMessage / pushBounded / shouldSkipDuplicate 三個 helper
mcp/index.js                              — 套 helper：complianceEvents 改環形緩衝 (上限 500)、
                                            console.error 過 sanitize、_autoComplyDedup 改 Map+滑動時間窗
tests/mcp-hardening.test.js               — 新增（17 case：3 個 helper 各自的快樂路徑/邊界/分鐘交界回歸）
package.json                              — 1.17.58 → 1.17.59
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.58 → 1.17.59
CHANGELOG.md                              — v1.17.59 條目
```

## v1.17.58 修改（IR-024 commit-msg hook）

```
hooks/ownmind-git-commit-msg              — 新增（bash 鉤子，IR-024 commit message 偵測）
install.sh                                — 加 5 行：複製 ownmind-git-commit-msg 到 ~/.ownmind/git-hooks/
install.ps1                               — 加對應邏輯（Copy-AsLf + LF 行尾）
tests/git-hook-co-authored-by.test.js     — 新增（7 個測試）
package.json                              — 1.17.57 → 1.17.58
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.57 → 1.17.58
CHANGELOG.md                              — v1.17.58 條目
docs/superpowers/specs/2026-05-07-git-hook-co-authored-by-design.md  — 新增（spec）
docs/superpowers/plans/2026-05-07-git-hook-co-authored-by.md         — 新增（plan）
```

## v1.17.57 修改（整體分析報告改正面肯定 + 拿掉冗餘描述句）

```
src/lib/llm-narrative.js                 — SYSTEM_PROMPT rule 3 範例改正面
                                            肯定（主要開發者、貢獻極大）；
                                            rule 6 強化禁止個人風險評價
                                            （離職、扛太多、接不下去、bus factor）
src/public/me/index.html                 — 拿掉「過去 N 天的全團隊使用分析…」描述句
tests/llm-narrative.test.js              — pin 正面肯定 + 個人風險禁用詞
package.json / README* / docs/README*    — 1.17.56 → 1.17.57
CHANGELOG.md                             — v1.17.57 條目
```

## v1.17.56 修改（v1.17.55 顯示問題修正：Tokens 估算 + 長專案名）

```
src/routes/me-narrative.js               — project_ranking 改 (user_id, tool)
                                            bridge：usr_tok CTE 加總期間總量，
                                            proj CTE 按 turns 比例分配；
                                            REGEXP_REPLACE 砍掉「( ... )」描述
src/routes/me.js                         — myProjects + projectContrib 兩個
                                            SQL 同步加 REGEXP_REPLACE 名稱正規化
src/public/me/index.html                 — renderProjectRankingTable：欄頭加 *，
                                            下方註明「估算值（按輪次比例分配）」
package.json / README* / docs/README*    — 1.17.55 → 1.17.56
CHANGELOG.md                             — v1.17.56 條目
```

## v1.17.55 修改（各專案活動量排行加 Tokens + 成本欄）

```
src/routes/me-narrative.js               — project_ranking SQL：加 CTE 從
                                            token_usage_daily 用 (user_id,
                                            tool, session_id) JOIN，按
                                            last_ts ${tfTs} 過濾，加總 5 種
                                            tokens + cost_usd
src/public/me/index.html                 — renderProjectRankingTable：表頭加
                                            「Tokens」「成本」兩欄，tokens 用
                                            fmtBig（1.2M），成本 $X.XX；
                                            6. 標題改「大家的OwnMind行為分析」
                                            2. 標題改「大家的OwnMind版本」
package.json / README* / docs/README*    — 1.17.54 → 1.17.55
CHANGELOG.md                             — v1.17.55 條目
```

## v1.17.54 修改（LLM prompt 友善白話 + 踩坑三段式）

```
src/lib/llm-narrative.js                 — SYSTEM_PROMPT 改寫：
                                            1. project_friction schema 改 {what,impact,mitigation}
                                            2. Rule 2 範例改白話（去「大使」用「常用 AI 的人」）
                                            3. Rule 5 三段式 friction + 禁 AI 自言自語
                                            4. 新增 Rule 7 行話黑名單（大使/賦能/對齊/扛...）
src/public/me/index.html                 — renderNarrativeInsights 新增 renderFricItem()
                                            三段式渲染：what 粗體、impact/mitigation 灰字 13px
                                            向下相容舊版字串
tests/llm-narrative.test.js              — pin prompt 規格（三段式 / 行話黑名單 / AI 工作量）
package.json / README* / docs/README*    — 1.17.53 → 1.17.54
CHANGELOG.md                             — v1.17.54 條目
```

## v1.17.53 修改（誠信表 UX 強化）

```
src/routes/me-narrative.js                — compliance query 加 WHERE 過濾全零列
                                            ORDER BY 改 violate DESC, user_name, rule_code
src/public/me/index.html                  — renderComplianceTable() violate > 0 紅色加粗
package.json / README* / docs/README*     — 1.17.52 → 1.17.53
CHANGELOG.md                              — v1.17.53 條目
```

## v1.17.52 修改（誠信表加「使用者」欄）

```
src/routes/me-narrative.js                — compliance query 改 GROUP BY (user_id, rule_code)
                                            JOIN users + memories(user_id, code) 帶該 user 自己的 title
src/public/me/index.html                  — renderComplianceTable() 多一欄「使用者」
                                            ORDER BY user_name → rule_code
package.json / README* / docs/README*     — 1.17.51 → 1.17.52
CHANGELOG.md                              — v1.17.52 條目
```

## v1.17.51 修改（誠信表 IR 代號加白話說明）

```
src/routes/me-narrative.js                — compliance query 改 CTE，JOIN memories
                                            DISTINCT ON (code) 取最新 IR title
src/public/me/index.html                  — renderComplianceTable() 顯示 IR title
                                            （代號粗體 + title 灰字小字）
package.json / README* / docs/README*     — 1.17.50 → 1.17.51
CHANGELOG.md                              — v1.17.51 條目
```

## v1.17.50 修改（事件代號加白話說明）

```
src/public/me/index.html                  — 加 EVENT_LABELS 對照表 + eventLabel() helper
                                            renderEventTypesTable / renderUpdateHealthTable
                                            從 1 欄改 2 欄（原始代號 + 白話說明）
package.json / README* / docs/README*     — 1.17.49 → 1.17.50
CHANGELOG.md                              — v1.17.50 條目
```

## v1.17.49 修改（預設密碼不再公開洩漏）

```
src/public/me/index.html                  — 登入頁副標 + 改密碼 placeholder 拿掉明碼
src/public/index.html                     — addUser() 收到 default_password 後 alert 顯示
src/routes/admin.js                       — POST /admin/users response 多 default_password
                                            （shared default 才回傳，admin 自設不洩漏）
package.json / README* / docs/README*     — 1.17.48 → 1.17.49
CHANGELOG.md                              — v1.17.49 條目
```

## v1.17.48 修改（整體分析 上線後修正）

```
src/public/me/index.html                  — 長條圖 CSS 修正（flex 衝突 → width 固定）
                                            「敘事報告」→「整體分析」改名
src/lib/llm-narrative.js                  — prompt 加正反例 + 規範洞察必須具體
package.json / README* / docs/README*     — 1.17.47 → 1.17.48
CHANGELOG.md                              — v1.17.48 條目
```

## v1.17.47 修改（/me 敘事報告）

```
src/lib/llm-narrative.js                  — 新增（llm-switch OpenAI-compatible wrapper）
src/lib/narrative-cache.js                — 新增（in-memory TTL hash cache）
src/routes/me-narrative.js                — 新增（mechanical + insights endpoints + PII redact）
src/app.js                                — 掛 /api/me/narrative 路由（須在 /api/me 之前）
src/public/me/index.html                  — 加第 4 tab「📊 敘事報告」+ 11 section render
                                            + auto LLM trigger + range change re-fetch
.env.example                              — 補 LLM_SWITCH_API_KEY 說明
tests/narrative-cache.test.js             — 4 tests
tests/llm-narrative.test.js               — 13 tests
tests/me-narrative.test.js                — 8 tests（4 mechanical + 4 insights）
docs/superpowers/specs/2026-05-07-me-narrative-report-design.md  — 新增（spec）
docs/superpowers/plans/2026-05-07-me-narrative-report-plan.md    — 新增（plan）
package.json / README* / docs/README*     — 1.17.46 → 1.17.47
CHANGELOG.md                              — v1.17.47 條目
```
