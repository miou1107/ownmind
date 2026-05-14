# v1.18.9 — 詳細規格

> 拍板結果見 proposal.md section 3。本檔為對應拍板結果的最終規格。
>
> 變更紀錄（2026-05-14）：
> - 決策 1 改為「訊息流 markdown 連結 → 開瀏覽器確認頁」（原規劃 A：CLI echo + URL）
> - 決策 2 改為「網頁確認頁面（按一次 1 秒完成）+ CLI 並存」
> - 新增 E 章「latency_ms 埋點」（合併原 v1.18.6 漏作項）
> - A.4「防誤點」維持不變（同 user 同 event 5 分鐘內 dedup）

---

## A. 規則阻擋誤殺率（C6）

### A.1 客戶端提示（決策 1 = 訊息流 markdown 連結）

`hooks/ownmind-reply-lint.js` 偵測違反時、結尾印：

```
【OwnMind v1.18.9】鐵律觸發：IR-037（中英混雜超 15%）
    ⚠️ 偵測到 26.3% 中英混雜、超過 15% 閾值
    [👎 擋錯了？點這](https://kkvin.com/ownmind/feedback/block?event_id=evt_abc123&sig=4f8a2b1c)
```

關鍵設計：
- markdown 連結格式（`[文字](URL)`）— Cursor / Gemini / Codex / OpenCode 等正常 client 顯示為可點藍色連結；Claude Code 摺疊卡片時 user 可手動展開
- `event_id` 由 reply-lint hook 從 `mcp/ownmind-log.js` 寫進 `activity_logs.client_event_id` 並注入連結 query
- `sig` = HMAC-SHA256(`event_id|user_id|day_bucket`, secret) 取前 16 字元
  - `day_bucket = floor(unix_ts / 86400)`、24h 內有效、過期回 410 Gone
  - secret 從既有 `ENCRYPTION_KEY` 衍生（`HMAC-SHA256(ENCRYPTION_KEY, 'ownmind-feedback-sig-v1')`），不需新增環境變數、零部署成本

### A.2 網頁確認頁面 + CLI 並存（決策 2 = 按一次 1 秒完成）

#### A.2.1 網頁確認頁面（主管道）

`GET /feedback/block?event_id=xxx&sig=yyy`：

```html
<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <title>OwnMind 回報誤殺</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 480px; margin: 80px auto; padding: 24px; text-align: center; }
    button { padding: 16px 32px; font-size: 18px; background: #d33; color: white; border: none; border-radius: 8px; cursor: pointer; }
    button:disabled { background: #888; cursor: not-allowed; }
    .ok { color: green; font-size: 18px; }
  </style>
</head>
<body>
  <h2>確認回報這次擋錯了嗎？</h2>
  <p>事件 ID：<code>evt_abc123</code></p>
  <button id="confirm" onclick="report()">👎 確認擋錯了</button>
  <p id="status"></p>
  <script>
    async function report() {
      const btn = document.getElementById('confirm');
      btn.disabled = true;
      const r = await fetch('/api/feedback/block', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_id: new URLSearchParams(location.search).get('event_id'),
          sig: new URLSearchParams(location.search).get('sig'),
        }),
      });
      document.getElementById('status').className = r.ok ? 'ok' : '';
      document.getElementById('status').innerText = r.ok ? '✓ 已回報、感謝！1 秒後自動關閉' : '✗ 回報失敗：' + r.status;
      if (r.ok) setTimeout(() => window.close(), 1000);
    }
  </script>
</body>
</html>
```

關鍵設計：
- 不要任何表單欄位、不要 reason 輸入框 — 按一下就完成
- `window.close()` 在多數瀏覽器不能關 user 主動開的 tab；網頁顯示「請手動關閉」也可接受
- 不需登入（簽名 URL 本身就是授權）

#### A.2.2 CLI 通道（並存、給 power user / AI agent）

```
~/.ownmind/bin/ownmind report-false-positive --event-id=xxx [--reason="..."]
```

底層 POST `/api/feedback/block`、用 `Authorization: Bearer ${OWNMIND_API_KEY}` 取代 sig query param。

#### A.2.3 server endpoint

`POST /api/feedback/block`：

請求 body（兩種授權擇一）：
```json
{
  "event_id": "evt_abc123",
  "sig": "4f8a2b1c",                    // 網頁路徑
  "client_event_id": "<uuid v4>"        // 自動產生、防 dedup race
}
// 或
{
  "event_id": "evt_abc123",
  "reason": "...",                       // 可選、僅 CLI 路徑提供
  "client_event_id": "<uuid v4>"
}
```

server 邏輯：
1. 驗證授權（sig 或 Bearer token）
2. 校驗 `event_id` 確實存在於 `activity_logs` 且事件類型可被 false positive 標記
3. 寫入 `activity_logs.event='block_feedback'`、`details: {original_event_id, reason?, source: 'web'|'cli'}`
4. 回 200 `{ok: true}` 或 409（5 分鐘內已回報過）

### A.3 SQL 算誤殺率

```sql
WITH blocks AS (
  SELECT COUNT(*) AS total
  FROM activity_logs
  WHERE event='iron_rule_compliance' AND details->>'action'='violate'
    AND ts > NOW() - INTERVAL '7 days'
),
feedbacks AS (
  SELECT COUNT(*) AS false_positives
  FROM activity_logs
  WHERE event='block_feedback' AND ts > NOW() - INTERVAL '7 days'
)
SELECT
  false_positives,
  total,
  ROUND(false_positives::numeric / NULLIF(total, 0) * 100, 1) AS false_positive_rate_pct
FROM blocks, feedbacks;
```

### A.4 防誤點

同 user 同 `original_event_id` 5 分鐘內：
- 第 1 次：寫入 block_feedback
- 第 2 次以後：return 409 + "already recorded"、不重複寫

---

## B. 4 種安全告警

### B.1 偵測規則（決策 3 = B：只通知、不自動暫停）

| 告警類型 | 偵測位置 | 條件 | 寫入 |
|---|---|---|---|
| `private_memory_leak` | `src/middleware/auth.js` 之後、`/api/memory/sync` 回傳前 | 回傳 memory 集合內任一 `user_id` ≠ `req.user.id` | usage_audit_log |
| `secret_value_in_logs` | winston transport 寫入時 | logs 內容 contains `secrets.value` 字串（從 cache 抓 secrets value 清單） | usage_audit_log |
| `cross_user_access` | 所有 `/api/memory/*` 回傳前 | 回傳 memory.user_id ≠ req.user.id（同 `private_memory_leak`、廣義版） | usage_audit_log |
| `bulk_read_alert` | `/api/memory/sync` rate limit | 同 user_id / api_key 1h 內成功讀取 > 1000 筆 memory | usage_audit_log |

### B.2 告警通知（決策 3 = B）

寫 usage_audit_log 後、不自動暫停帳號。改成：

1. 管理員儀表板「健康度」分頁實時顯示告警列表
2. 嚴重告警（4 種任一）：寄 email 給 super_admin 帳號（Vin 個人）
3. Vin 看完後、admin 網頁手動「暫停帳號」按鈕（既有 disabled 機制）

### B.3 大量資料外洩閾值（決策 4 = A：1h > 1000 筆）

```js
// src/middleware/safety-alerts.js
const BULK_READ_THRESHOLD = 1000;
const WINDOW_HOURS = 1;

async function checkBulkRead(userId, apiKey) {
  const count = await query(`
    SELECT COUNT(*) FROM activity_logs
    WHERE user_id = $1
      AND event = 'memory_get'
      AND ts > NOW() - INTERVAL '${WINDOW_HOURS} hours'
  `, [userId]);
  
  if (count > BULK_READ_THRESHOLD) {
    await writeAudit('bulk_read_alert', userId, {
      count,
      window_hours: WINDOW_HOURS,
      api_key_id: apiKey?.id,
    });
  }
}
```

### B.4 告警 SQL（管理員儀表板用）

```sql
-- 過去 7 天嚴重告警件數（4 種）
SELECT
  event_type,
  COUNT(*) AS alerts,
  COUNT(DISTINCT user_id) AS affected_users,
  MIN(ts) AS first_seen,
  MAX(ts) AS last_seen
FROM usage_audit_log
WHERE event_type IN (
  'private_memory_leak',
  'secret_value_in_logs',
  'cross_user_access',
  'bulk_read_alert'
)
  AND ts > NOW() - INTERVAL '7 days'
GROUP BY event_type
ORDER BY COUNT(*) DESC;
```

---

## C. 管理員儀表板「健康度」分頁

`src/public/index.html` 既有 admin 網頁加新 tab：

### C.1 顯示內容

```
╔══════════════════════════════════════════════════════╗
║  OwnMind 健康度（過去 7 天）                          ║
╠══════════════════════════════════════════════════════╣
║  📊 規則阻擋誤殺率：8.3% (3/36) — 綠燈              ║
║  🚨 嚴重告警：0 件 ✓                                 ║
║                                                      ║
║  違反：5 件                                          ║
║  遵守：73 件                                         ║
║  觸發鐵律覆蓋：25 / 41 (61%)                         ║
║  活躍 user 數（週）：4                                ║
╚══════════════════════════════════════════════════════╝
```

### C.2 隱私邊界

- 「擋錯了」回饋 reason 內容**不顯示**給管理員、只顯示 user_id + 告警類型 + 件數
- 安全告警**不顯示**詳細 user_id、只顯示「N 個 user 受影響」（按 Gemini r3「最小樣本 10」未達標時隱藏）
- 例外：Vin 自己（super_admin）可看完整 audit log

---

## D. 端到端流程範例

### 場景 1：使用者覺得 reply-lint 擋錯

1. AI 回話完、reply-lint 偵測 IR-037 違反、寫 `activity_logs.event='iron_rule_compliance'`、`details.action='violate'`、`client_event_id='evt_abc'`
2. terminal 印警告 + 「擋錯了？跑 ownmind report-false-positive --event-id=evt_abc」
3. 使用者跑 CLI 指令
4. server 寫 `block_feedback` 事件、details: `{original_event_id: 'evt_abc', reason: '...'}`
5. 管理員儀表板誤殺率 +1

### 場景 2：偵測到 user 越權存取

1. user A 跑 `GET /api/memory/sync`、req.user.id = A
2. 因 bug、回傳結果包含 user B 的 memory
3. middleware 偵測 `回傳 memory.user_id ≠ req.user.id`、寫 `usage_audit_log.event_type='cross_user_access'`
4. super_admin 收到 email 通知
5. Vin 進管理員網頁看 audit log 細節、手動暫停 user A 或修 bug

---

## E. MCP API latency_ms 埋點（合併原 v1.18.6 漏作項）

### E.1 埋點位置

`mcp/index.js` `setRequestHandler(CallToolRequestSchema, async (request) => { ... })` 主流程：

```js
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const startedAt = Date.now();   // ← 新增
  try {
    const result = await handleTool(name, args || {});
    const latencyMs = Date.now() - startedAt;   // ← 新增
    autoComplyForToolCall(name, args || {}, result).catch(...);

    // 既有：fetch broadcast、組 response
    ...

    // 新增：寫 latency event（fire-and-forget、不阻塞 response）
    try {
      logEvent('mcp_call', {
        tool: name,
        latency_ms: latencyMs,
        status: 'ok',
      });
    } catch {}

    return composeToolResponse({...});
  } catch (error) {
    const latencyMs = Date.now() - startedAt;   // ← 新增
    logEvent('error', { ...enrichErrorDetails(error, name, args), latency_ms: latencyMs });
    return { content: [...] };
  }
});
```

### E.2 Server 端 SQL（健康度日報加 section 8）

```sql
SELECT
  details->>'tool' AS tool,
  COUNT(*) AS calls,
  ROUND(AVG((details->>'latency_ms')::int)::numeric, 0) AS avg_ms,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (details->>'latency_ms')::int)::numeric, 0) AS p50_ms,
  ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY (details->>'latency_ms')::int)::numeric, 0) AS p95_ms,
  ROUND(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY (details->>'latency_ms')::int)::numeric, 0) AS p99_ms
FROM activity_logs
WHERE event = 'mcp_call'
  AND ts > NOW() - INTERVAL '24 hours'
  AND details->>'latency_ms' IS NOT NULL
GROUP BY details->>'tool'
ORDER BY p95_ms DESC NULLS LAST;
```

### E.3 紅燈閾值

p95 > 3000ms 標紅燈（個別 tool）。觀測 1 個月後再調。

### E.4 為什麼放 client 端而非 server 端

server 端只能量「網路+server 處理時間」；client 端 (mcp/index.js) 量「user 看到 result 的真實感受時間」、包含 broadcast fetch、autoComply、composeToolResponse 等所有環節。後者更接近 user 體感、是 v1.18.5 提案 C4 指標的真實意圖。
