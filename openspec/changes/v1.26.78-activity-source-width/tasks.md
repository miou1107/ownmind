# v1.26.78 — Tasks

Legend: `[ ]` pending · `[x]` done

## Phase 0 — Found while gathering evidence for something else

- [x] Vin asked for proof that his upgrade was verified. Counting errors in the production
      log turned up two at 03:49:14, both `value too long for type character varying(10)`.
- [x] Not the collector path: `activity_logs.source` is `VARCHAR(10)`, and `system_auto`
      (11), `session_audit` (13) and `system_server_auto` (18) are written to it.
- [x] Age established from the data, not from the code: `SELECT source, count(*) FROM
      activity_logs GROUP BY source` returns only `mcp`, `hook`, `api`, `e2e-test` across
      ~31,000 rows. These values have never once been stored.
- [x] Blast radius established from the handler: one `try` around the whole loop, so the
      throw 500s the request and the entire batch is rejected.

## Phase 1 — RED

- [x] `tests/activity-source-width.test.js`, 5 tests: the declared width, every source
      literal fits it, headroom beyond the longest, per-event isolation, and the response
      reporting failures.
- [x] One of them passed on the first run for the wrong reason: the window after
      `res.json({ inserted` was wide enough to catch the string
      "activity log batch upload failed" in the catch block below it. Tightened to the
      `res.json` call itself, then it failed correctly. **A test that passes before the fix
      is a test that is measuring something else.**

## Phase 2 — GREEN

- [x] `db/020_activity_source_width.sql` — `VARCHAR(10)` → `VARCHAR(64)`. Catalog-only in
      Postgres: an ACCESS EXCLUSIVE lock, no row rewrite, returns immediately.
- [x] `src/routes/activity.js` — per-event `try`, a `failed` counter, and a log line naming
      the event type and source rather than one anonymous 500.

## Phase 3 — Verify

- [x] Full suite: 2954 tests, 2952 pass, 0 fail, 2 skipped.
- [x] Deployed to production 04:06. `db/020` applied on boot; `information_schema` now
      reports `character_maximum_length = 64`.
- [x] **Positive control through the real API, not a query.** Posted a two-event batch with
      `source: 'system_auto'` and `source: 'system_server_auto'` — the two values that had
      never once been stored in the product's history. Response
      `{"inserted":2,"deduped":0,"failed":0,"total":2}`, and both rows present with their
      full source values. Before this deploy that same request would have 500'd and stored
      neither.
- [x] Both probe rows deleted afterwards, verified zero left, and the source distribution
      is back to what it was.

## Phase 4 — Sync

- [x] `package.json` 1.26.78, `README.md` ×3, `CHANGELOG.md`, `FILELIST.md`
- [x] `openspec/BACKLOG.md` — the batch route is not injectable, so its per-event isolation
      has only a structural test

## The third one today

Three defects found by deploying, none visible to a passing suite:

| version | what | why the suite could not see it |
|---|---|---|
| v1.26.76 | heartbeat SQL refused by Postgres | every test hands the route a fake `query` |
| v1.26.77 | self-check always 401 | client tests fake `fetch`, endpoint tests fake `auth` |
| v1.26.78 | whole activity batches rejected | no test ever inserted into a real column |

Same shape each time, and it now has a rule of its own: where a test fakes both sides of a
contract, it measures the fakes agreeing with each other.
