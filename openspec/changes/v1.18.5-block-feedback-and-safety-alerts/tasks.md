# v1.18.5 — 實作 Tasks

> 待 Vin 拍板 proposal section 3 五個決策後、再展開細節。
> 估算量約 3~5 天（含 TDD + 品管 + 部署）。

---

## Phase 1：規則阻擋誤殺率（C6）— 估 1~2 天

### T1.1 寫 reproduction test（IR-003）
- `tests/block-feedback.test.js`
- 涵蓋：
  - POST /api/feedback/block 寫入 block_feedback event
  - 5 分鐘內同 client_event_id 重複回報 → 409
  - 缺 event_id → 400
  - reason 可選、超 500 字截斷
- 預期：所有 test 紅燈、實作後綠燈

### T1.2 後端 endpoint
- `src/routes/block-feedback.js`：POST /api/feedback/block
- 寫進 `activity_logs.event='block_feedback'`
- 用 client_event_id partial unique index dedup（既有機制）

### T1.3 客戶端 CLI
- `bin/ownmind`：bash wrapper（依平台選 cmd / sh）
- subcommand：`report-false-positive --event-id=xxx [--reason="..."]`
- 底層 fetch POST 加 Authorization Bearer ${OWNMIND_API_KEY}

### T1.4 reply-lint Stop hook 加提示
- `hooks/ownmind-reply-lint.js` 違反時印「擋錯了？跑：ownmind report-false-positive --event-id={client_event_id}」
- client_event_id 已由 mcp/ownmind-log.js 生成、傳進 details

### T1.5 SQL 算誤殺率
- `scripts/health-report-daily.sh` 加 section 7：誤殺率
- 公式見 spec.md A.3

---

## Phase 2：4 種安全告警 — 估 2~3 天

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
  - `checkBulkRead(userId, apiKey)` — async 後台檢查

### T2.3 寫 audit log helper
- `src/utils/safety-audit.js`：`writeAudit(type, userId, details)`
- 統一介面、避免每處各寫一遍

### T2.4 super_admin 通知
- `src/jobs/safety-alert-notifier.js`：cron 每 5 分鐘掃 audit log、新告警 email
- 用既有 nodemailer 設定（或 SMTP）
- email 範本：純文字、敏感資料用占位符

### T2.5 secrets value cache
- 為 `checkSecretInLogs` 提供 secrets value 清單
- 5 分鐘 TTL、不要每次 query DB
- 注意：cache 本身的 logs 不能 dump value

---

## Phase 3：管理員儀表板「健康度」分頁 — 估 1 天

### T3.1 後端 endpoint
- `src/routes/admin-health.js`：GET /admin/api/health
- 回傳 JSON：
  - 阻擋誤殺率（7 天）
  - 4 種告警件數
  - 違反/遵守/觸發覆蓋率（複用 health-report-daily SQL）

### T3.2 前端 tab
- `src/public/index.html` 加 「健康度」分頁
- 純 HTML + JS、複用既有 admin auth 機制
- 5 個指標卡 + 7 天趨勢 sparkline（chart.js 太重、用 SVG 手繪）

### T3.3 隱私邊界檢查
- < 10 user 群組不顯示細節（按 Gemini r3 建議）
- 「擋錯了」reason 內容不顯示給非 super_admin
- 寫 `scripts/privacy-audit.js`、每季手動跑

---

## Phase 4：發版 + 部署 — 估 半天

### T4.1 品管三步驟（IR-012/045）
- `superpowers:verification-before-completion` — 跑全測試 + browser 實測
- `superpowers:requesting-code-review` — 找 Codex / Gemini review
- `superpowers:receiving-code-review` — 嚴謹回應 review feedback

### T4.2 同步文件（IR-008/026/032）
- package.json: 1.18.4 → 1.18.5
- README.md / docs/README.zh-TW.md / docs/README.ja.md 版號
- CHANGELOG.md 加 v1.18.5 entry
- FILELIST.md 加新檔列表

### T4.3 部署（IR-018/023）
- `docker compose build --no-cache api`
- `docker compose up -d api`
- health endpoint check
- 跑一次 health-report-daily.sh、確認新指標正常出來

### T4.4 browser 實測（IR-020）
- admin 網頁「健康度」分頁實際打開看
- 跑 CLI ownmind report-false-positive 確認寫入 DB
- 故意觸發 cross_user_access（test user 跑跨 user query）看 audit log 有寫

### T4.5 Tag + push
- `git tag v1.18.5`
- `git push origin main --tags`
- 廣播通知所有 client 升級（既有 broadcast 機制）

---

## 風險檢核清單（commit 前必跑）

- [ ] reproduction test 全綠（IR-003）
- [ ] 沒 blind edit、改動有對應的 test（IR-005）
- [ ] README/FILELIST/CHANGELOG 三處同步（IR-008/026）
- [ ] package.json / 三語 README 版號同步（IR-031/032）
- [ ] 鐵律「擋錯了」按鈕在 reply-lint 警告時實際顯示（browser/CLI 實測 IR-020）
- [ ] 4 種告警偵測規則跑模擬資料、寫進 audit log（IR-020）
- [ ] CLI ownmind 指令向後相容、舊 user 端跑得起來（IR-022 Server + Client 兩端）
- [ ] 不在 logs 印 secrets value（B.2 secret_value_in_logs 偵測規則自己會擋）
- [ ] 沒加 Co-Authored-By（IR-024）
- [ ] commit message 用 Vin、不用 Claude（IR-009）
