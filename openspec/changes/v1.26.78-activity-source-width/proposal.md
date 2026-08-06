# v1.26.78 — a ten-character column, eleven-character values, whole batches lost

## What happened

Found in the production log while verifying the v1.26.77 deploy:

```
[ERROR] memory_save iron_rule observed_trigger write failed
        {"error":"value too long for type character varying(10)"}
[ERROR] activity log batch upload failed
        {"error":"value too long for type character varying(10)"}
```

`activity_logs.source` is `VARCHAR(10)`. The values written to it are longer:

| value | length | written by |
|---|---|---|
| `system_auto` | 11 | the MCP, on every auto-detected compliance event |
| `system_server_auto` | 18 | the server, for its own observed_trigger rows |
| `session_audit` | 13 | the MCP session audit |

`mcp/ownmind-log.js:107` lifts `details.source` into the column, so these reach it as the
stored value rather than staying inside the JSON.

## How long

Since the column was created. The table proves it: across ~31,000 rows the only sources
ever stored are `mcp`, `hook`, `api` and `e2e-test`. Not one `system_auto` in the product's
history.

## Why it is worse than a missing row

`POST /api/activity/batch` had a single `try` around the whole loop. One over-long value
threw, escaped, and the request 500'd — **every event in that batch was rejected**, not
just the bad one. The client's spool then retries the same batch, which fails the same way.

The visible cost is on 統計儀表板: the iron-rule compliance rate and the activity counts
are computed from rows that never arrived.

## The fix

**1. Widen the column** (`db/020`) to `VARCHAR(64)`.

Widened rather than shortening the strings, and the reason decides it: installed clients
send these values too, and some will not be upgraded soon — v1.26.29 is still in the field.
Shortening the server's literals would leave every one of those clients still failing.

64 rather than the 24 the longest current value needs, because sizing a column to today's
longest string is the same defect waiting for tomorrow's.

**2. Give each event its own `try`.** A rejected event now costs one event, is counted, and
is logged with its type and source so the next one of these is visible immediately instead
of appearing as a single anonymous 500. The response gained a `failed` count.

## Honest limitation

The batch handler uses the module-level `query` import rather than an injected one, so the
loop cannot be driven from a test the way `createEventsRouter` can. The isolation is
therefore asserted structurally, which is weaker than asserting the behaviour. Making that
route injectable is its own change, recorded in the backlog.
