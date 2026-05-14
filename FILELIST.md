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
│   │   ├── secret.js                # 密鑰管理（AES-256 加密；v1.17.91 POST 改 upsert + 寫 activity_log audit）
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
│   │   ├── semver.js               # v1.17.0 — parseSemver / compareSemver / isLower / isHigher（version 比對共用）
│   │   ├── enrich-activity.js      # v1.17.89 + v1.17.90 — activity_log 落 DB 前 enrich：所有 disable/update 自動 snapshot disabled_type；iron_rule 額外 snapshot disabled_code+disabled_title
│   │   └── iron-rule-quality.js    # v1.17.94 — 鐵律品質 lint（trigger tag / 適用情境 / 規則段落 / 字數 / 中英混雜 / context 依賴詞），server POST/PUT iron_rule 強制檢查
│
├── shared/                          # 跨 server + client + hook 共用 lib
│   └── language-lint.js            # v1.17.95 — IR-037 中英混雜 + IR-036 行話檢查的純函式（給 iron-rule lint + Stop hook reply-lint 共用）
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
│   ├── ownmind-tty-echo.cjs        # v1.17.71 — PostToolUse hook：把【OwnMind】banner 寫到 user terminal（繞過 Claude Code UI）
│   ├── ownmind-reply-lint.js       # v1.17.96 — Stop hook：每輪 AI 回話結束跑 IR-037/IR-036 lint、違反印 banner + 報 violate
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
│       ├── sync-memory-files.js        # v1.17.8 — 雲端 → 本地 md 檔 delta sync（stdin JSON / --fail mode）
│       └── flush-compliance-spool.js   # v1.17.97 — SessionStart 補送 reply-lint-pending.jsonl 到 /api/activity/batch（POST 200 後刪檔）
│
├── scripts/                         # 維護工具腳本
│   ├── bootstrap.sh                 # v1.17.6 — Universal Bootstrap（Mac/Linux/Git Bash）：三分支處理 install/upgrade/repair
│   ├── bootstrap.ps1                # v1.17.6 — Universal Bootstrap（Windows PowerShell）：同上
│   ├── update.sh                    # Auto-update：同步 skill、hooks、settings 到所有 AI 工具
│   ├── check-sync.sh                # v1.17.2 — 三層 drift 健檢（L1 git / L2 server version / L3 deploy diff）
│   ├── migrate-verification.js      # 鐵律 verification 一次性遷移
│   ├── install-helpers/
│   │   ├── add-post-tool-use-hook.cjs  # v1.17.71 — 把 ownmind-tty-echo PostToolUse hook idempotent 寫入 settings.json
│   │   ├── add-stop-hook.cjs           # v1.17.96 — 把 ownmind-reply-lint Stop hook idempotent 寫入 settings.json
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
│   ├── install-prerequisite-auto-install.test.js # v1.17.76 — 缺 node/git 時 install.ps1/sh 自動安裝（vin-windows-test 回報 7 條 contract test）
│   ├── start-cmd-node-fallback.test.js     # v1.17.77 — start.cmd 多層 node fallback + install.ps1 寫 User PATH（vin-windows-test 第二輪 5 條）
│   ├── install-started-beacon.test.js     # v1.17.78 — install_started beacon + 接受 minimal payload（IR-038 觀測管道補洞 7 條）
│   ├── error-spool-mechanism.test.js       # v1.17.79 — errors/ spool 統一錯誤回報 + dirty tree auto-recover（IR-038 廣域觀測管道 15 條）
│   ├── install-beacon-spool-fallback.test.js # v1.17.80 — install_started beacon 失敗 spool fallback（vin-windows-test 第四輪 4 條）
│   ├── update-script-observability.test.js  # v1.17.81 — update.ps1 heredoc StackOverflow fix + beacon/report-error wiring（vin-windows-test 第五輪 8 條）
│   ├── install-check-null-byte-sanitize.test.js # v1.17.83 — server JSONB null byte sanitize（vin-windows-test 第六輪 5xx 風暴 4 條）
│   ├── spool-retry-cap.test.js              # v1.17.83 — retrySpool 達 MAX 後 drop 避免無限重送（3 條）
│   ├── upgrade-windows-file-lock.test.js    # v1.17.84 — Windows file-lock 偵測 + check-sync.sh L2 grep fallback（vin-windows-test 第七輪 7 條）
│   ├── install-failed-beacon.test.js        # v1.17.85 — interactive-upgrade FAIL 函式統一補 fallback report_error（IR-038 觀測盲點補強 3 條）
│   ├── debug-route-beacon-version.test.js   # v1.17.85 — debug.js beacon trigger client_version 強制 NULL，admin query 不再被 sentinel 污染（6 條）
│   ├── upgrade-complete-beacon.test.js      # v1.17.86 — upgrade_complete beacon + SessionStart drain spool（IR-038 兩 source 對不上修補 + IR-007 同類雷收尾 7 條）
│   ├── me-pitfalls.test.js                  # v1.17.87 — /api/me/pitfalls 跨 user 踩坑紀錄 endpoint + me.js sensitive event 拿掉 handoff_create + memory.js save/disable 補 server compliance log + me.html 踩坑 tab UI（17 條）
│   ├── me-trailing-slash.test.js            # v1.17.88 — /me 沒尾斜線 301 redirect 到 me/（相對路徑避開 nginx prefix 問題、條件式避開 strict routing=false 無限循環）（3 條）
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

## v1.17.75 修改（文件化 Claude Code 體驗降級 — β 路線：保留 hook / 不再投資補救）

```
README.md / docs/README.zh-TW.md / docs/README.ja.md
                                          — 三語新增「Client Experience Matrix」/
                                            「OwnMind 在不同 AI 客戶端的體驗」/
                                            「異なるAIクライアントでのOwnMind体験」
                                            區塊。對照表列每個 client 的 banner
                                            體驗 + 為什麼。Claude Code 標 ⚠️ 降級
                                            體驗、鏈到 Anthropic Issue #11120。
                                            版本徽章 1.17.74 → 1.17.75
package.json                              — 1.17.74 → 1.17.75
CHANGELOG.md / FILELIST.md                — 補 v1.17.75 條目
```

## v1.17.74 修改（contract test 參數化 — 1→8 條，覆蓋 broadcast / multi-part / 空 / 壞 parts 變體）

```
tests/ownmind-tty-echo.test.js            — contract test 從 1 條變 8 條（contractCases
                                            array + for loop 生成 8 個獨立 it），
                                            覆蓋單 banner / 雙 banner / 廣播 / 廣播+混合 /
                                            multi-part / 空 parts / 壞 part / 純文字
                                            8 種變體；conditional cleanup 修 v1.17.73 m-6
                                            （13→20 條）
package.json                              — 1.17.73 → 1.17.74
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.73 → 1.17.74
CHANGELOG.md / FILELIST.md                — 補 v1.17.74 條目
```

## v1.17.73 修改（結構性拆 v1.17.71/v1.17.72 fixture 集體偽陽性雷 — IR-007 follow-through）

```
tests/ownmind-tty-echo.test.js            — 新增 mcpToolResponse / legacyToolResponse
                                            兩個 fixture helper；4 條既有測試遷移到
                                            mcpToolResponse、2 條（測試名明確談 content
                                            的）保留 legacyToolResponse、混搭兩種
                                            shape；新增 1 條結構性 contract test
                                            「兩種 shape 同 banner 文字產出 block 必須
                                            一致」（12→13 條）
package.json                              — 1.17.72 → 1.17.73
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.72 → 1.17.73
CHANGELOG.md / FILELIST.md                — 補 v1.17.73 條目
```

## v1.17.72 修改（修 v1.17.71 在場感 100% 失效 — IR-007 雷型）

```
hooks/ownmind-tty-echo.cjs                — extractBanners 同時支援兩種 prod
                                            tool_response 結構：直接 array（MCP
                                            tool 走這條）+ { content: [...] }
                                            （舊版/其他 tool）。v1.17.71 只處理
                                            後者，導致 prod MCP banner 抽不到、
                                            user 100% 看不到。
tests/ownmind-tty-echo.test.js            — +1 IR-007 regression test（11→12 條），
                                            用真實 PostToolUse stdin 截下來的結構
                                            （含 session_id / hook_event_name /
                                            tool_use_id 等真實欄位）；先紅後綠
                                            驗證 fix。
package.json                              — 1.17.71 → 1.17.72
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.71 → 1.17.72
CHANGELOG.md / FILELIST.md                — 補 v1.17.72 條目
```

## v1.17.71 修改（OwnMind 在場感 — 直寫 user terminal 繞過 AI 過濾）

```
hooks/ownmind-tty-echo.cjs                — 新增（跨平台 Node helper）
                                            從 PostToolUse stdin 讀 JSON、抓
                                            「【OwnMind vX.Y.Z】XXX」 + 「📢 OwnMind」
                                            banner、合併成招牌區塊、寫 /dev/tty 或
                                            \\.\CONOUT$；fallback 寫 banner-pending.jsonl
                                            給下次 SessionStart 補印；嚴禁寫
                                            stderr/stdout（規格 #3 不被 AI 吃）
scripts/install-helpers/add-post-tool-use-hook.cjs
                                          — 新增（idempotent merge PostToolUse hook 到
                                            ~/.claude/settings.json；backup + atomic +
                                            rollback；保留 user 既有設定）
hooks/ownmind-session-start.sh            — 開頭呼叫 flush-pending-banners.js 補印
                                            （stderr → user-visible 通道）+ 清空檔案
hooks/lib/flush-pending-banners.js        — 新增（一次 spawn node 串流讀整個
                                            pending file 印 stderr，避免 bash while
                                            loop per-line spawn 在 50+ 積壓時卡頓）
install.sh                                — MCP 設定後呼叫 add-post-tool-use-hook helper
install.ps1                               — Windows 對稱（用同一支 cjs helper）
tests/ownmind-tty-echo.test.js            — 新增（11 條：banner 抽取/合併/廣播/空輸入/
                                            壞 JSON/fallback JSON Lines/stderr 必空白/
                                            主路徑 tty 寫入）
tests/add-post-tool-use-hook.test.js      — 新增（8 條：created/added/skipped 三狀態 +
                                            idempotent + backup + 絕對 path + 壞 JSON
                                            不污染原檔）
package.json                              — 1.17.70 → 1.17.71
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.70 → 1.17.71
CHANGELOG.md / FILELIST.md                — 補 v1.17.71 條目
```

## v1.17.70 修改（升級備份自動清除 — IR-027 邏輯卡控）

```
scripts/interactive-upgrade.sh            — 升級成功末段加 find -mtime +N sweep
                                            支援 OWNMIND_BACKUP_RETENTION_DAYS env
                                            覆蓋（預設 7 天）。Sweep 失敗不擋升級
scripts/interactive-upgrade.ps1           — 對稱實作 Get-ChildItem + Where
                                            LastWriteTime -lt cutoff + Remove-Item
scripts/bootstrap.sh                      — 修復路徑 log 訊息「3 天後可手動刪除」
                                            改「下次升級自動清除超過 7 天」
scripts/bootstrap.ps1                     — 同上 PS 版本
tests/sweep-old-backups.test.js           — 新增（8 條：find -mtime / -maxdepth /
                                            -name 邊界 + retention 0 + 空目錄 +
                                            upgrade 腳本內容檢查）
package.json                              — 1.17.69 → 1.17.70
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.69 → 1.17.70
CHANGELOG.md / FILELIST.md                — 補 v1.17.70 條目
```

## v1.17.69 修改（MCP 回傳合併單一 text part — 修 Claude Code 看不到技巧提示）

```
mcp/lib/compose-tool-response.js          — 新增（純函式：把 broadcast / tag / body / tip
                                            合併成單一 { type: 'text', text } part，
                                            所有 MCP client 渲染一致）
mcp/index.js                              — 把原本 4 個 contentParts.push 換成
                                            composeToolResponse({...}) 呼叫
tests/mcp-tool-response-shape.test.js     — 新增（8 條：單一 part 結構、tag/body
                                            視覺分隔、有無 broadcast/tip 都正確）
tests/tip-every-call.test.js              — 更新 assert pattern 對齊新結構，仍驗
                                            tip 必須無條件附（不能有 % 10 閘門）
package.json                              — 1.17.68 → 1.17.69
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.68 → 1.17.69
CHANGELOG.md / FILELIST.md                — 補 v1.17.69 條目
```

## v1.17.68 修改（settings.json `--update` 殘留地雷 + 401 觀測管道 IR-007/IR-038）

```
src/middleware/auth.js                    — 401 path 加 logger.warn('auth_failed',...)
                                            帶 route / ip / masked_key / ua；新增 maskApiKey()
                                            純函式 + 第 4 個參數 deps={} 測試注入點
scripts/install-helpers/self-check.cjs    — 新增 checkApiKeyFormat 純函式（不打 server，
                                            純看 key 字串長相），抓 v1.17.9 之前 install.ps1
                                            沒過濾 flag-like args 殘留的 settings.json 存量問題
                                            （Adam 從 2026-03-26 到 2026-05-08 都吃 401 的根因）；
                                            排在 api_credentials 之前，fail 訊息明確指向修法
tests/auth-401-observability.test.js      — 新增（7 條：maskApiKey 邊界 + auth middleware
                                            401 / no-bearer logger.warn shape）
tests/self-check.test.js                  — 加 10 條 checkApiKeyFormat 測試
package.json                              — 1.17.67 → 1.17.68
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.67 → 1.17.68
CHANGELOG.md / FILELIST.md                — 補 v1.17.68 條目
```

## v1.17.67 修改（v1.17.66 Windows scanner task hotfix + IR-007 防同類雷）

```
scripts/windows/register-scanner-task.ps1 — 刪除 -DontStartIfOnBatteries 和
                                            -StopIfGoingOnBatteries 兩個拼錯的 PS param
                                            （v1.17.66 上線後讓 Windows scanner task 完全沒
                                            註冊、token 用量報告卡 0）；
                                            stale Write-Host 「every 30 min」修為「every 120 min」
tests/ps1-windows-compat.test.js          — 反轉舊 test：assert 兩個壞 param 必須不存在；
                                            新增 New-ScheduledTaskSettingsSet param 白名單驗證
                                            （IR-007 Persistent Bug Protocol — 防字串對 / 語意錯
                                            的同類雷）
install.ps1                              — Tee register-scanner-task.ps1 stdout+stderr 到
                                            ~/.ownmind/logs/register-task-<ts>.log；訊息「30 分鐘」
                                            改「120 分鐘」（IR-038 觀測管道）
scripts/install-helpers/self-check.cjs    — detectSchedulerDetail 新增 readLatestRegisterLog()，
                                            把最新 register-task 日誌（最多 8KB）併入
                                            scheduler_detail.register_log，admin 可從
                                            install_check_logs 直接看 PS error stack
package.json                             — 1.17.66 → 1.17.67
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.66 → 1.17.67
CHANGELOG.md / FILELIST.md               — 補 v1.17.67 條目
```

## v1.17.65 修改（autostash fallback 死路徑 — v1.17.24 backlog 清完）

```
mcp/index.js                             — autostash fallback 從 git pull --autostash 改 --ff-only
                                            （主路徑 + fallback 都帶 --autostash 等於沒 fallback）
tests/mcp-auto-update-cross-platform.test.js — 加 1 條 regression（fallback args 不可含 --autostash）
package.json                             — 1.17.64 → 1.17.65
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.64 → 1.17.65
CHANGELOG.md / FILELIST.md               — 補 v1.17.65 條目
```

## v1.17.64 修改（self-check endpoint + auth header 修正）

```
scripts/install-helpers/self-check.cjs   — checkApiCredentials 從 POST /api/init 改 GET /api/memory/init；
                                            api_credentials + uploadReport 兩處 header 從 X-OwnMind-API-Key
                                            改 Authorization: Bearer
tests/self-check.test.js                 — 加 2 條 regression（驗 URL + Bearer header）
package.json                             — 1.17.63 → 1.17.64
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.63 → 1.17.64
CHANGELOG.md / FILELIST.md               — 補 v1.17.64 條目
```

## v1.17.63 修改（安裝/升級自動 self-check + 上傳 log）

```
scripts/install-helpers/self-check.cjs   — 新增（7 項本機檢查、寫 log、上傳 server）
db/011_install_check_logs.sql            — 新增（schema migration）
src/routes/debug.js                      — 新增（POST /api/debug/install-check 收 log）
tests/self-check.test.js                 — 新增（13 case：parseArgs / summarize / sanitizePath / buildReport / smoke）
tests/debug-route.test.js                — 新增（5 case：auth / 成功 / 缺欄位 / 過大 / DB 錯）
src/app.js                               — 掛 /api/debug router
install.sh / install.ps1                 — 結尾呼叫 self-check（trigger=post_install）
scripts/interactive-upgrade.sh / .ps1    — 結尾呼叫 self-check（trigger=post_upgrade）
docs/superpowers/specs/2026-05-08-install-self-check-design.md — 新增（spec）
package.json                             — 1.17.62 → 1.17.63
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.62 → 1.17.63
CHANGELOG.md                             — v1.17.63 條目
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

## v1.17.66 修改（Windows 平台硬化 + 觀測管道修補 IR-038）

```
新增 — 三個共用 helper（架構性，防同類雷）：
  scripts/windows/lib/find-git-bash.ps1     — Find-GitBash + Test-IsGitBash，過濾 WSL relay
  scripts/install-helpers/safe-spawn.cjs    — Win32-friendly execFile（shell:false + windowsHide:true）
  scripts/install-helpers/path-to-win32.cjs — MSYS /c/X ↔ Win32 C:\X 雙向轉換

新增 — 視窗隱藏 launcher：
  scripts/windows/run-hidden.vbs            — wscript GUI subsystem 隱藏 console（Bug #7-a）

新增 — OpenSpec：
  openspec/changes/v1.17.66-windows-hardening/proposal.md  — 七個 bug 根因 + 架構性發現
  openspec/changes/v1.17.66-windows-hardening/spec.md      — Helper API + GIVEN/WHEN/THEN
  openspec/changes/v1.17.66-windows-hardening/tasks.md     — 0~10 階段執行清單

修改：
  scripts/interactive-upgrade.ps1           — 三處 bash 改用 Find-GitBash（#1）
                                              所有 Out-File 加 -Encoding utf8（#6）
                                              整個流程包 try/finally，self-check 在 finally 保證執行（#4）
                                              verify_local 失敗不再 Rollback（觀測 ≠ 升級成功與否）
  scripts/install-helpers/self-check.cjs    — checkScheduler 改用 safeSpawn 拿掉 shell:true（#2）
                                              新增 appendSpool / retrySpool / 重寫 uploadReport（#4 spool）
                                              新增 collectEnv / detectShellChain / detectBashResolution
                                              / detectSchedulerDetail / detectWindowsEncoding（IR-038）
                                              buildReport 接受可選 env 參數
  scripts/windows/register-scanner-task.ps1 — Action 改用 wscript.exe + run-hidden.vbs 包 node.exe（#7-a）
                                              RepetitionInterval 30 → 120 分鐘（#7-b）
                                              加 -DontStartIfOnBatteries + -StopIfGoingOnBatteries（#7-b）
  tests/ps1-windows-compat.test.js          — 加 v1.17.66 Bug #1 / #6 / #7 / #4 reproduction（11 條）
  tests/self-check.test.js                  — 加 v1.17.66 Bug #2 / #4 spool / collectEnv reproduction（9 條）
  package.json / README* / docs/README*     — 1.17.65 → 1.17.66
  CHANGELOG.md                              — v1.17.66 條目
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

## v1.18.6 新增 / 修改 (Error 事件觀測缺口補完)

修改的既有檔:
```
mcp/index.js                        — 新增 enrichErrorDetails helper（line ~28）
                                      改 catch error 從 { tool_name, error } 變
                                      豐富 details (error/error_message/error_name/
                                      stack/http_status/payload_summary)
                                      payload_summary 只記結構 metadata、不洩內容
package.json / README* / CHANGELOG.md / FILELIST.md — 1.18.5 → 1.18.6
```

## v1.18.5 新增 / 修改 (Hotfix: big skill sync 從 v1.18.0 上線就壞)

修改的既有檔:
```
hooks/lib/conditional-sync-cli.js   — syncToAllTools 從 top-level static import
                                      改成 if (refreshed) 區段內 dynamic import
                                      失敗時 outer try/catch 抓住、graceful degrade
scripts/update.sh                   — 開頭加 idempotent check 補裝 js-yaml
                                      --no-save 不污染 package.json
scripts/update.ps1                  — Windows 版同步補
package.json / README* / CHANGELOG.md / FILELIST.md — 1.18.4 → 1.18.5
```

## v1.18.4 新增 / 修改 (產品健康度日報雛形 + tool='unknown' fallback 修正)

新增檔:
```
scripts/health-report-daily.sh         — bash SSH 進 prod 跑 6 條 SQL、輸出健康度日報
                                         只看絕對數字、不算比例、避免冷啟動誤導
```

修改的既有檔:
```
mcp/ownmind-log.js                     — TOOL_NAME fallback 從 'unknown' 改 'claude-code'
                                         加 OWNMIND_CLIENT_TOOL alias、向後相容
mcp/index.js                           — 同上、TOOL_NAME 跟 ownmind-log.js 同步
package.json / README* / CHANGELOG.md / FILELIST.md — 1.18.3 → 1.18.4
```

## v1.18.3 新增 / 修改 (Hotfix: lint metadata 漏餵 + reply-lint Stop hook 安裝腳本漏修)

修改的既有檔:
```
src/routes/memory.js                  — POST + PUT lintIronRule call 加 metadata
src/routes/admin-iron-rule-upgrade.js — PUT lintIronRule call 加 metadata
scripts/update.sh                     — 補 add-stop-hook + add-post-tool-use-hook
scripts/update.ps1                    — 同步補 (Windows)
tests/iron-rule-origin-context.test.js — +3 regression test (lint 收 metadata 才正確)
package.json / README* / CHANGELOG.md / FILELIST.md — 1.18.2 → 1.18.3
```

## v1.18.2 新增 / 修改 (鐵律時空背景 origin_context — Vin 提的需求)

新增檔:
```
src/utils/iron-rule-origin-context.js — pure helpers (validate/render/inject/capture)
tests/iron-rule-origin-context.test.js — 19 cases
scripts/backfill-iron-rule-origin-context.js — backfill 35 條既有鐵律 user_direct
```

修改的既有檔:
```
src/utils/iron-rule-quality.js        — lintIronRule 加 checkOriginContext (warning 不擋)
mcp/index.js                          — ownmind_save schema 加 4 個 iron_rule 欄位 + 自動 capture
skills/ownmind-memory.md              — 教 AI 主動帶 origin_event/user_quote/origin_confidence
src/routes/admin-iron-rule-upgrade.js — PUT 接受 origin_event/user_quote、injectOriginSection
src/public/index.html                 — 升級助手 modal 加 2 input + 藍色提示框
src/routes/memory.js                  — PUT metadata-only update bypass content lint
```

## v1.18.1 新增 / 修改 (Hotfix: 移除 IR-037 中英混雜 lint)

修改的既有檔:
```
src/utils/iron-rule-quality.js        — 移除 IR-037 (兩處)
src/utils/iron-rule-suggest.js        — 加 round-trip lint check + lint_ok/errors
src/routes/admin-iron-rule-upgrade.js — response 加 lint_ok/lint_errors
src/public/index.html                 — modal 進場預先顯示 lint errors
tests/iron-rule-quality.test.js       — IR-037 測試改反映新行為
scripts/audit-real-iron-rules-lint.js — 新檔: baseline audit
```

## v1.18.0 新增 / 修改（鐵律對齊 SKILL.md 標準 + 1 big skill 跨工具 + conditional sync + 升級助手 admin Web UI）

新增檔（rc1 schema）:
```
src/utils/iron-rule-frontmatter.js    — js-yaml JSON_SCHEMA 安全 frontmatter 解析
db/013_iron_rule_previous_content.sql — ALTER memories ADD previous_content TEXT
tests/iron-rule-frontmatter.test.js   — 13 cases
tests/iron-rule-quality-skill-md.test.js — 26 cases (S1-S9 + B1 fallback)
```

新增檔（rc2 conditional sync + 跨工具）:
```
src/utils/iron-rule-sync.js           — buildBigSkillMd + buildReferenceFile + syncToFilesystem (3 kind) + atomic write
hooks/lib/conditional-sync.js         — readCache/writeCache/shouldRefreshCache/runConditionalSync
hooks/lib/conditional-sync-cli.js     — sh hook wrapper (額外打 sync 拿鐵律 list、syncToAllTools)
tests/sync-token-endpoint.test.js     — 10 cases (generateSyncToken pure + validateSyncToken)
tests/iron-rule-sync.test.js          — 23 cases (pure builders + 真 fs IO)
tests/conditional-sync.test.js        — 24 cases (mock fetch + tmp cache)
```

新增檔（rc3 升級助手）:
```
src/utils/iron-rule-suggest.js        — template-based SKILL.md proposal (ASCII name + hash)
src/routes/admin-iron-rule-upgrade.js — 3 endpoints (status/suggest/upgrade)
tests/iron-rule-suggest.test.js       — 8 cases
```

修改的既有檔:
```
src/utils/iron-rule-quality.js        — lintIronRule dispatch (frontmatter → schema lint / 沒 → legacy)
src/routes/memory.js                  — POST/PUT format/warnings response + previous_content + GET /sync-token
src/utils/syncToken.js                — queryFn 注入式 (test 友善)
src/app.js                            — mount /api/admin/iron-rules
src/public/index.html                 — admin 新「鐵律升級」tab + diff modal + 升級流程
hooks/ownmind-session-start.sh        — 改用 conditional-sync-cli wrapper + fallback
package.json / package-lock.json      — + js-yaml ^4.1.1
package.json / README* / docs/README* — 1.17.99 → 1.18.0
CHANGELOG.md / FILELIST.md            — v1.18.0 條目
```

OpenSpec:
```
openspec/changes/v1.18.0-iron-rule-schema/proposal.md (v4)
openspec/changes/v1.18.0-iron-rule-schema/spec.md
openspec/changes/v1.18.0-iron-rule-schema/tasks.md
```

## v1.17.99 新增 / 修改（Dedup helper 抽 + MCP log 帶 id + 移 node-fetch 依賴）

新增檔：

```
src/utils/activity-insert.js                 — pure helper：normalizeClientEventId + insertActivityLog
tests/mcp-log-event-uuid.test.js             — 3 條 mcp/ownmind-log client_event_id 測試
```

修改的既有檔：

```
src/routes/activity.js                       — import helper、移除 inline UUID_V4_REGEX 跟 40 行 INSERT
tests/activity-batch-dedup.test.js           — buildApp 改用真 helper、+6 條 helper unit test
mcp/ownmind-log.js                           — logEvent 加 client_event_id (UUID v4)、移 node-fetch import
mcp/index.js                                 — 移 node-fetch import (改用 global fetch)
mcp/package.json                             — 移 node-fetch dep
mcp/package-lock.json                        — 同步 lock
package.json / README* / docs/README*        — 1.17.98 → 1.17.99
CHANGELOG.md                                 — v1.17.99 條目
```

## v1.17.98 新增 / 修改（Server 端 dedup — client_event_id partial unique index）

新增檔：

```
db/012_activity_event_dedup.sql              — ALTER activity_logs + partial unique index
tests/activity-batch-dedup.test.js           — 8 條 server dedup 行為測試（mock query）
```

修改的既有檔：

```
src/routes/activity.js                       — POST /batch 拆兩條 INSERT path、加 deduped 計數
hooks/ownmind-reply-lint.js                  — buildComplianceEvents 加 client_event_id (UUID v4)
tests/reply-lint-pending-spool.test.js       — +2 條 client_event_id 必須出現在 spool / archive
tests/flush-compliance-spool.test.js         — +1 條 flush 必須轉送 client_event_id
package.json / README* / docs/README*        — 1.17.97 → 1.17.98
CHANGELOG.md                                 — v1.17.98 條目
```

## v1.17.97 新增 / 修改（SessionStart spool flush + Windows path 兩個 v1.17.96 backlog 解掉）

新增檔：

```
hooks/lib/flush-compliance-spool.js          — SessionStart 補送 helper
tests/flush-compliance-spool.test.js         — 11 條 flush helper 契約測試
tests/reply-lint-pending-spool.test.js       — 5 條 hook 條件 spool 測試
```

修改的既有檔：

```
hooks/ownmind-reply-lint.js                  — postEvents 回 boolean、只在 POST 失敗才 spool pending
hooks/ownmind-session-start.sh               — 加一段呼叫 flush-compliance-spool.js（接在 banner flush 後）
install.sh                                   — 2.1 + 2.2 段加 cygpath -w（Git Bash on Windows）
package.json / README* / docs/README*        — 1.17.96 → 1.17.97
CHANGELOG.md                                 — v1.17.97 條目
```

## v1.17.96 新增 / 修改（Stop hook 整合：回話品質 lint 真的卡 AI）

新增檔：

```
hooks/ownmind-reply-lint.js                  — Stop hook 主程式：讀 transcript、抽最後一輪 assistant text、跑 lintReply、違反印 banner + 報 violate
scripts/install-helpers/add-stop-hook.cjs    — install-time helper，把 Stop hook idempotent 寫進 ~/.claude/settings.json
tests/reply-lint-hook.test.js                — 12 條 hook 行為測試
tests/add-stop-hook.test.js                  — 9 條 install helper 測試
```

修改的既有檔：

```
install.sh                                   — 加段 2.2 呼叫 add-stop-hook.cjs（接在 v1.17.71 PostToolUse hook 後）
install.ps1                                  — Windows 版同樣加段 2.2
package.json / README* / docs/README*        — 1.17.95 → 1.17.96
CHANGELOG.md                                 — v1.17.96 條目
FILELIST.md                                  — hooks/ + scripts/install-helpers/ 樹補新檔
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
