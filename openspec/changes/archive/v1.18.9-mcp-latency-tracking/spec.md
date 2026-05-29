# v1.18.9 — Detailed spec

> See proposal.md section 3 for the decisions. This file is the final spec corresponding to those decisions.
>
> Change log (2026-05-14):
> - Decision 1 changed to "message-stream markdown link → open browser confirmation page" (original plan A: CLI echo + URL)
> - Decision 2 changed to "web confirmation page (one click, done in 1 second) + CLI in parallel"
> - Added chapter E "latency_ms instrumentation" (merging the originally-missed v1.18.6 item)
> - A.4 "anti-misclick" unchanged (dedup per user per event within 5 minutes)
>
> **⛔ Chapter A deprecated (2026-05-14 part 2):** The entire block_feedback feature is dropped; see the top of proposal.md for the reason. This chapter A is kept as a historical record and no longer implemented. The corresponding "false-positive metric card" in chapter C (health tab) is also removed, and "scenario 1" of chapter D is invalidated.

---

## A. Rule-block false-positive rate (C6)

### A.1 Client prompt (decision 1 = message-stream markdown link)

When `hooks/ownmind-reply-lint.js` detects a violation, it prints at the end:

```
【OwnMind v1.18.9】鐵律觸發：IR-037（中英混雜超 15%）
    ⚠️ 偵測到 26.3% 中英混雜、超過 15% 閾值
    [👎 擋錯了？點這](https://kkvin.com/ownmind/feedback/block?event_id=evt_abc123&sig=4f8a2b1c)
```

Key design:
- markdown link format (`[text](URL)`) — normal clients like Cursor / Gemini / Codex / OpenCode show it as a clickable blue link; in Claude Code the user can manually expand the collapsed card
- `event_id` is written by the reply-lint hook from `mcp/ownmind-log.js` into `activity_logs.client_event_id` and injected into the link query
- `sig` = HMAC-SHA256(`event_id|user_id|day_bucket`, secret) taking the first 16 characters
  - `day_bucket = floor(unix_ts / 86400)`, valid within 24h, returns 410 Gone when expired
  - the secret is derived from the existing `ENCRYPTION_KEY` (`HMAC-SHA256(ENCRYPTION_KEY, 'ownmind-feedback-sig-v1')`), no new environment variable needed, zero deployment cost

### A.2 Web confirmation page + CLI in parallel (decision 2 = one click, done in 1 second)

#### A.2.1 Web confirmation page (main channel)

`GET /feedback/block?event_id=xxx&sig=yyy`:

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

Key design:
- No form fields at all, no reason input box — one click and it's done
- `window.close()` cannot close a tab the user opened themselves in most browsers; showing "please close manually" on the page is acceptable
- No login needed (the signed URL is itself the authorization)

#### A.2.2 CLI channel (in parallel, for power users / AI agents)

```
~/.ownmind/bin/ownmind report-false-positive --event-id=xxx [--reason="..."]
```

Under the hood it POSTs to `/api/feedback/block`, using `Authorization: Bearer ${OWNMIND_API_KEY}` in place of the sig query param.

#### A.2.3 server endpoint

`POST /api/feedback/block`:

Request body (one of two authorizations):
```json
{
  "event_id": "evt_abc123",
  "sig": "4f8a2b1c",                    // web path
  "client_event_id": "<uuid v4>"        // auto-generated, prevents dedup race
}
// or
{
  "event_id": "evt_abc123",
  "reason": "...",                       // optional, only provided by the CLI path
  "client_event_id": "<uuid v4>"
}
```

Server logic:
1. Verify authorization (sig or Bearer token)
2. Validate that `event_id` actually exists in `activity_logs` and that the event type can be marked as a false positive
3. Write `activity_logs.event='block_feedback'`, `details: {original_event_id, reason?, source: 'web'|'cli'}`
4. Return 200 `{ok: true}` or 409 (already reported within 5 minutes)

### A.3 SQL to compute the false-positive rate

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

### A.4 Anti-misclick

For the same user and same `original_event_id` within 5 minutes:
- 1st time: write block_feedback
- 2nd time onward: return 409 + "already recorded", don't write again

---

## ⛔ B. 4 security alerts — deprecated (2026-05-14 part 3)

> Vin: "I don't need this feature". OwnMind is personal use, ROI is too low. The safety-detect.js + safety-audit.js + two tests already committed in 127b740 were all deleted. This chapter B is kept as a historical record and no longer implemented.
>
> The corresponding D.scenario 2 is also invalidated.

## B (deprecated). 4 security alerts

### B.1 Detection rules (decision 3 = B: notify only, no auto-suspend)

| Alert type | Detection point | Condition | Written to |
|---|---|---|---|
| `private_memory_leak` | after `src/middleware/auth.js`, before `/api/memory/sync` returns | any `user_id` in the returned memory set ≠ `req.user.id` | usage_audit_log |
| `secret_value_in_logs` | when the winston transport writes | log content contains a `secrets.value` string (the secrets value list pulled from cache) | usage_audit_log |
| `cross_user_access` | before all `/api/memory/*` responses | returned memory.user_id ≠ req.user.id (same as `private_memory_leak`, a generalized version) | usage_audit_log |
| `bulk_read_alert` | `/api/memory/sync` rate limit | same user_id / api_key successfully reading > 1000 memory rows within 1h | usage_audit_log |

### B.2 Alert notification (decision 3 = B)

After writing usage_audit_log, do not auto-suspend the account. Instead:

1. The admin dashboard "Health" tab shows the alert list in real time
2. Severe alert (any of the 4): send an email to the super_admin account (Vin personally)
3. After Vin reviews, use the admin web "suspend account" button manually (existing disabled mechanism)

### B.3 Bulk data exfiltration threshold (decision 4 = A: 1h > 1000 rows)

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

### B.4 Alert SQL (for the admin dashboard)

```sql
-- severe alert count over the past 7 days (4 types)
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

## ⛔ C. Admin dashboard "Health" tab — deprecated (2026-05-14 part 3)

> Originally meant to show "false-positive rate + 4 alerts + violations/compliance/coverage + latency p95". The first two were dropped along with block_feedback / security alerts, leaving a single "compliance numbers + latency" metric — not worth building a new tab. Vin himself is super_admin; to see the numbers he can just open the existing admin panel or run SQL.
>
> The corresponding Phase 3 is entirely dropped.

## C (deprecated). Admin dashboard "Health" tab

Add a new tab to the existing admin web page `src/public/index.html`:

### C.1 Displayed content

```
╔══════════════════════════════════════════════════════╗
║  OwnMind 健康度（過去 7 天）                          ║
╠══════════════════════════════════════════════════════╣
║  🚨 嚴重告警：0 件 ✓                                 ║
║                                                      ║
║  違反：5 件                                          ║
║  遵守：73 件                                         ║
║  觸發鐵律覆蓋：25 / 41 (61%)                         ║
║  活躍 user 數（週）：4                                ║
║  MCP latency p95：450ms（v1.18.9 加）                ║
╚══════════════════════════════════════════════════════╝
```

> **Removed 2026-05-14:** The "📊 rule-block false-positive rate" metric card was removed along with the block_feedback deprecation, replaced by an MCP latency p95 metric card (from the v1.18.9 latency instrumentation).

### C.2 Privacy boundary

- Security alerts **do not show** the detailed user_id, only "N users affected" (hidden per Gemini r3's "minimum sample 10" when not met)
- Exception: Vin himself (super_admin) can see the full audit log

---

## D. End-to-end flow examples

> 2026-05-14: Scenario 1 (reply-lint false-positive feedback) was dropped and removed along with chapter A.

### Scenario 2: unauthorized user access detected

1. user A runs `GET /api/memory/sync`, req.user.id = A
2. Due to a bug, the returned result contains user B's memory
3. middleware detects `returned memory.user_id ≠ req.user.id`, writes `usage_audit_log.event_type='cross_user_access'`
4. super_admin receives an email notification
5. Vin opens the admin web page to view the audit log details, manually suspends user A or fixes the bug

---

## E. MCP API latency_ms instrumentation (merging the originally-missed v1.18.6 item)

### E.1 Instrumentation point

The main flow of `mcp/index.js` `setRequestHandler(CallToolRequestSchema, async (request) => { ... })`:

```js
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const startedAt = Date.now();   // ← new
  try {
    const result = await handleTool(name, args || {});
    const latencyMs = Date.now() - startedAt;   // ← new
    autoComplyForToolCall(name, args || {}, result).catch(...);

    // existing: fetch broadcast, compose response
    ...

    // new: write latency event (fire-and-forget, does not block response)
    try {
      logEvent('mcp_call', {
        tool: name,
        latency_ms: latencyMs,
        status: 'ok',
      });
    } catch {}

    return composeToolResponse({...});
  } catch (error) {
    const latencyMs = Date.now() - startedAt;   // ← new
    logEvent('error', { ...enrichErrorDetails(error, name, args), latency_ms: latencyMs });
    return { content: [...] };
  }
});
```

### E.2 Server-side SQL (add section 8 to the health daily report)

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

### E.3 Red-line threshold

p95 > 3000ms is marked red (per individual tool). Adjust after 1 month of observation.

### E.4 Why on the client side rather than the server side

The server side can only measure "network + server processing time"; the client side (mcp/index.js) measures "the real perceived time until the user sees the result", including broadcast fetch, autoComply, composeToolResponse and all other stages. The latter is closer to the user's experience and is the true intent of the C4 metric in the v1.18.5 proposal.
