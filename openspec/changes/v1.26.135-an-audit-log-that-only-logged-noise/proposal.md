# v1.26.135 — Proposal: an audit log that only logged noise

## What was measured

Production, 2026-08-10, counted directly against `usage_audit_log`:

| | rows |
|---|---|
| whole table, since 2026-04-22 | **253,409** |
| of those, `event_type = 'unknown_model'` | **253,409** |
| any other event type | **0** |
| last 14 days | 94,713 |

Broken down by model, last 14 days:

| model | rows |
|---|---|
| claude-opus-5 | 62,405 |
| claude-opus-4-8 | 18,484 |
| claude-sonnet-5 | 10,397 |
| claude-fable-5 | 2,317 |
| gpt-5.5 | 1,100 |
| gpt-5.6-terra | 10 |

Every model in that list is a model the team uses every day. The table was growing by
roughly 6,700 rows a day and 100% of the growth was false alarms.

## Why

`lookupKnownModels()` in `src/routes/usage/events.js` answers "is this a model we recognise?"
by querying `model_pricing`. That was a reasonable proxy while pricing was a live feature.

**v1.26.60 removed cost computation.** `cost_usd` is written NULL on purpose and the
dashboards stopped selecting it. What nobody removed was the allowlist read: `model_pricing`
still exists, still holds its 2026-04 contents, and is still the only definition of "known
model" the ingest path has. Its newest Anthropic entry is `claude-opus-4-7`.

So from the moment the team moved to opus-5, every single ingested message failed the
allowlist and wrote an audit row. `token_regression`, `fingerprint_mismatch` and
`fingerprint_collision` all write to the same table — a real one would have been one row in
a quarter of a million.

Two separate defects, one cause:

1. **The check fires per message, not per model.** "A model we have never seen turned up" is
   news once. Repeating it 62,405 times is not a louder signal, it is the absence of one.
2. **The reference list is dead.** It was frozen the day pricing was dropped, so it now
   classifies the entire product's normal traffic as unknown.

This change fixes (1), which is what makes the table readable again. It deliberately does
**not** repopulate `model_pricing` — that would re-couple the audit to a table whose reason
for existing was removed. With one row per model, a stale allowlist costs one row per new
model rather than one per message, and that row is exactly the notification wanted.

## What changes

- An `unknown_model` row is written **once per `(tool, model)`, ever**. Before writing, the
  ingest path asks `usage_audit_log` which of the batch's unknown models already have a row,
  and drops those. Within a single batch, only the first message of each model claims the row.
- `db/024` adds a partial unique index on `(tool, details->>'model')` restricted to
  `event_type = 'unknown_model'`, and the insert gains `ON CONFLICT DO NOTHING`. Two uploads
  carrying the same never-seen model can both read "not reported" before either inserts; the
  index closes that window, and DO NOTHING keeps the loser from logging a write failure for a
  row it did not need.
- Other event types are untouched. They are per-message by design and the index does not
  cover them.
- The 253,409 existing rows were dumped to
  `/VinService/ownmind-backups/usage_audit_log-20260810.sql.gz` (8.4 MB) and the table was
  truncated, on Vin's instruction, 2026-08-10.

## What this does not fix

The event still has to be *ingested* before it can be audited, so a model that appears only
on a machine whose collector is dead still produces nothing. That is a separate problem,
tracked against Amiee's and Joanna's machines.

`model_pricing` remains in the schema and remains stale. Nothing reads it now except this
allowlist. Removing it is a larger cleanup and is not in this change.
