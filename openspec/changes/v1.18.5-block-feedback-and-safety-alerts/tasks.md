# v1.18.9 — 實作 Tasks

> 拍板完成（2026-05-14），按以下順序實作。worktree 名保留 `determined-bouman-20c22a`。
> 估算量約 4~6 天（含 TDD + 品管 + 部署 + latency 埋點）。

---

## ⛔ Phase 1：規則阻擋誤殺率（C6）— 棄用（2026-05-14 part 2）

> **棄用原因：** 拍板「網頁連結 → 1 秒確認」實作時撞牆——hook 無法簽 sig（沒 server secret）+ 網頁要登入違反 1 秒目標。三個替代方案 Vin 都拒絕、整個功能放棄。
>
> Phase 1 server 端程式（feedback-sig / block-feedback handler / 兩個 route / 兩個 test）已從 commit 8bcfc69 全部刪除，git 歷史保留作「曾嘗試」紀錄。
>
> 以下原 T1.1~T1.7 規格保留作歷史記錄，**不再實作**。

## Phase 1（已棄用）：規則阻擋誤殺率（C6）— 原估 1.5~2 天

### T1.1 寫 reproduction test（IR-003）
- `tests/block-feedback.test.js`
- 涵蓋：
  - POST /api/feedback/block + 合法 sig → 200，寫 block_feedback event
  - POST + Bearer token → 200（CLI 路徑）
  - sig 過期（25h 前）→ 410 Gone
  - sig 簽名錯誤 → 401
  - 5 分鐘內同 (event_id, user_id) 重複回報 → 409
  - 缺 event_id → 400
  - reason 超 500 字截斷
  - 不存在的 event_id → 404
- 預期：所有 test 紅燈、實作後綠燈

### T1.2 HMAC 簽名 helper
- `src/utils/feedback-sig.js`：`signFeedback(eventId, userId)` / `verifyFeedback(eventId, userId, sig)`
- secret 從 `HMAC-SHA256(ENCRYPTION_KEY, 'ownmind-feedback-sig-v1')` derive，不新增環境變數
- day_bucket = floor(unix_ts / 86400)，24h 內有效
- pure module、secret derive 結果可注入測試

### T1.3 後端 endpoint
- `src/routes/block-feedback.js`：
  - POST /api/feedback/block — 兩種授權擇一（sig query body 或 Bearer header）
  - 寫 `activity_logs.event='block_feedback'`、`details: {original_event_id, reason?, source}`
  - 用 client_event_id partial unique index dedup（既有機制）

### T1.4 網頁確認頁
- `src/routes/feedback-page.js`：GET /feedback/block 渲染 spec.md A.2.1 的 HTML（inline、無模板）
- 接收 query: event_id, sig
- 不需登入

### T1.5 客戶端 CLI（並存通道）
- `bin/ownmind`：bash wrapper（依平台選 cmd / sh）
- subcommand：`report-false-positive --event-id=xxx [--reason="..."]`
- 底層 fetch POST 加 `Authorization: Bearer ${OWNMIND_API_KEY}`
- IR-042：必須同步更新 install.sh / install.ps1 / update.sh / update.ps1 以安裝 bin/ownmind

### T1.6 reply-lint Stop hook 加 markdown 連結
- `hooks/ownmind-reply-lint.js` 違反時印：
  ```
  [👎 擋錯了？點這](https://kkvin.com/ownmind/feedback/block?event_id=xxx&sig=yyy)
  ```
- sig 由 reply-lint hook 跑 server side call (`POST /api/feedback/sign`) 取得；或預先共享 secret 在 client 端算（先選後者、避免每次擋下都打 server）
- client_event_id 已由 mcp/ownmind-log.js 生成、傳進 details

### T1.7 SQL 算誤殺率 + 紅燈閾值
- `scripts/health-report-daily.sh` 加 section 7：誤殺率
- 公式見 spec.md A.3
- 紅燈閾值 30%（拍板決策 5）

---

## Phase 2：4 種安全告警 — 估 2~2.5 天

### T2.1 寫 reproduction test（IR-003）
- `tests/safety-alerts.test.js`
- 涵蓋 4 種告警觸發 + 不觸發的邊界
- 模擬 cross_user_access：跑 fake middleware 看 audit_log 有寫入

### T2.2 偵測 middleware
- `src/middleware/safety-alerts.js`
- 4 個獨立函式：
  - `checkPrivateMemoryLeak(req, res)` — 用 res.json wrap
  - `checkSecretInLogs(logMessage)` — 用 winston format hook
  - `checkCrossUserAccess(req, res, memories)` — middleware
  - `checkBulkRead(userId, apiKey)` — async 後台檢查、閾值 1000/h（拍板決策 4）

### T2.3 寫 audit log helper
- `src/utils/safety-audit.js`：`writeAudit(type, userId, details)`
- 統一介面、避免每處各寫一遍

### T2.4 super_admin email 通知（拍板決策 3 = 只通知）
- `src/jobs/safety-alert-notifier.js`：cron 每 5 分鐘掃 audit log、新告警 email
- 用既有 nodemailer 設定（或 SMTP）
- email 範本：純文字、敏感資料用占位符
- **不**自動暫停帳號

### T2.5 secrets value cache
- 為 `checkSecretInLogs` 提供 secrets value 清單
- 5 分鐘 TTL、不要每次 query DB
- 注意：cache 本身的 logs 不能 dump value

---

## Phase 3：管理員儀表板「健康度」分頁 — 估 1 天

### T3.1 後端 endpoint
- `src/routes/admin-health.js`：GET /admin/api/health
- 回傳 JSON：
  - 阻擋誤殺率（7 天）+ 紅燈閾值 30%
  - 4 種告警件數
  - 違反/遵守/觸發覆蓋率（複用 health-report-daily SQL）
  - mcp_call latency p50/p95/p99（new！見 Phase A）

### T3.2 前端 tab
- `src/public/index.html` 加「健康度」分頁
- 純 HTML + JS、複用既有 admin auth 機制
- 6 個指標卡（誤殺率 / 4 告警 / 違反 / 遵守 / 覆蓋率 / latency p95）
- 7 天趨勢 sparkline（chart.js 太重、用 SVG 手繪）

### T3.3 隱私邊界檢查
- < 10 user 群組不顯示細節（按 Gemini r3 建議）
- 「擋錯了」reason 內容不顯示給非 super_admin
- 寫 `scripts/privacy-audit.js`、每季手動跑

---

## Phase A：MCP API latency_ms 埋點（合併原 v1.18.6 漏作）— 估 0.5 天

### TA.1 寫 reproduction test
- `mcp/tests/latency-instrumentation.test.js`
- 涵蓋：
  - 成功 tool call 寫 `mcp_call` event 含 `latency_ms` 整數
  - 失敗 tool call 寫 `error` event 含 `latency_ms`
  - latency_ms 不阻塞 response（mock logEvent throw 不影響回傳）

### TA.2 mcp/index.js 埋點
- 見 spec.md E.1
- 只動 setRequestHandler 主流程
- 配合既有 enrichErrorDetails（v1.18.6/.7 加的）

### TA.3 server 端 SQL
- `scripts/health-report-daily.sh` 加 section 8：latency p50/p95/p99 by tool
- 公式見 spec.md E.2
- 紅燈閾值 p95 > 3000ms

---

## Phase 4：發版 + 部署 — 估 1 天

### T4.1 品管三步驟（IR-012/045）
- `superpowers:verification-before-completion` — 跑全測試 + browser 實測
- `superpowers:requesting-code-review` — 找 Codex / Gemini review
- `superpowers:receiving-code-review` — 嚴謹回應 review feedback

### T4.2 同步文件（IR-008/026/032）
- package.json: 1.18.8 → **1.18.9**
- mcp/package.json: 1.18.8 → **1.18.9**
- README.md / docs/README.zh-TW.md / docs/README.ja.md 版號（IR-031/032 三處同步）
- CHANGELOG.md 加 v1.18.9 entry
- FILELIST.md 加新檔列表
- IR-034：新增 Server 讀檔路徑時同步 Dockerfile COPY

### T4.3 部署（IR-018/023）
- `docker compose build --no-cache api`
- `docker compose up -d api`
- health endpoint check
- 跑一次 health-report-daily.sh、確認新指標（誤殺率 + 4 告警 + latency p95）正常出來

### T4.4 browser 實測（IR-020）
- admin 網頁「健康度」分頁實際打開看
- reply-lint 故意觸發、實際點 markdown 連結看跳到確認頁
- 跑 CLI ownmind report-false-positive 確認寫入 DB
- 故意觸發 cross_user_access（test user 跑跨 user query）看 audit log 有寫
- 故意跑慢的 mcp tool 看 mcp_call event 有 latency_ms

### T4.5 Tag + push
- `git tag v1.18.9`（IR-031：發版時 package.json / SERVER_VERSION / git tag 三處同步）
- `git push origin main --tags`
- nightly job 隔天 03:30 自動更新 broadcast 版號（不需手動）

---

## Phase 5：清雲端過期記憶 — 估 5 分鐘

### T5.1 ownmind_update 標記過期
- cloud_id=299「OwnMind v1.17.24+ backlog」— 三項已修完（autostash v1.17.65 / lock cleanup v1.17.60 / settings overwrite load-settings-safe.cjs），改 description 加「[2026-05-14 已全修完、可刪除]」或直接刪
- cloud_id=342「OwnMind v1.17.95+ backlog」— 還有效（觸發條件未到、規則式 lint 仍夠用）、保留

---

## 風險檢核清單（commit 前必跑）

- [ ] reproduction test 全綠（IR-003）
- [ ] 沒 blind edit、改動有對應的 test（IR-005）
- [ ] README/FILELIST/CHANGELOG 三處同步（IR-008/026）
- [ ] package.json / mcp/package.json / 三語 README 版號同步 v1.18.9（IR-031/032）
- [ ] 4 種告警偵測規則跑模擬資料、寫進 audit log（IR-020）
- [ ] 4 種告警觸發後 super_admin 收到 email、**沒**自動暫停帳號（拍板決策 3）
- [ ] mcp_call event 寫 latency_ms 整數、不阻塞 response（TA.1）
- [ ] 不在 logs 印 secrets value（B.2 secret_value_in_logs 偵測規則自己會擋）
- [ ] 沒加 Co-Authored-By（IR-024）
- [ ] commit message contributors 用 Vin、不用 Claude（IR-009）
