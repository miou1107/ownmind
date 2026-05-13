# v1.18.5 — 詳細規格

> 待 Vin 拍板 proposal.md section 3 五個決策後、再展開本檔細節。
> 以下是按「我建議」欄位的預設規格、Vin 改了決策後相應調整。

---

## A. 規則阻擋誤殺率（C6）

### A.1 客戶端按鈕（決策 1 = A：terminal echo + URL）

`hooks/ownmind-reply-lint.js` 偵測違反時、結尾印：

```
【OwnMind v1.18.5】鐵律觸發：IR-037（中英混雜超 15%）
    ⚠️ 偵測到 26.3% 中英混雜、超過 15% 閾值
    擋錯了？跑：ownmind report-false-positive --event-id=evt_abc123
```

`event_id` 由 reply-lint hook 寫進 `activity_logs.client_event_id`、跟回饋對應。

### A.2 CLI 回報（決策 2 = B：純 CLI 不開瀏覽器）

新增 MCP tool：

```js
ownmind_report_false_positive({
  event_id: 'evt_abc123',
  reason: '對話內提到的英文是技術術語、不算混雜'  // 可選
})
```

實際上、由於使用者要在 terminal 跑、寫 CLI binary：

```
~/.ownmind/bin/ownmind report-false-positive --event-id=xxx [--reason="..."]
```

底層呼叫 POST `/api/feedback/block`：

```json
{
  "event_id": "evt_abc123",
  "reason": "對話內提到的英文是技術術語",
  "client_event_id": "<uuid v4>"
}
```

server 寫 `activity_logs.event='block_feedback'`、`details: {original_event_id, reason}`。

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
