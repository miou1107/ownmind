# v1.26.64 — Search stops answering with everything it found

Bug #11, filed by Vin 2026-08-05 08:43, `component: memory / search`.

## What happens

`GET /api/memory/search` runs `SELECT *` with no `LIMIT` and returns every matching row in
full. A common keyword answers with a quarter of a million characters, which exceeds the
tool-output ceiling, so the AI receives nothing usable. Search that returns everything
returns nothing.

Reproduced in this session while verifying Bug #7: the query
`Claude Desktop 多帳號切換 OSS` returned three memories, one of them a multi-thousand-word
project record, complete, including sections the query had nothing to do with.

Two aggravating details in the same `SELECT *`:

- **`previous_content`**, the archived prior version of every edited memory. Search pays
  for two copies of the text and uses neither.
- **`metadata`**, which for an iron rule carries the whole `origin_context` block
  including the user quote that produced it.

`GET /api/session/recent`, which `ownmind_search` calls in the same breath and merges into
one response, is `SELECT * FROM session_logs` with no `LIMIT` either. Fixing only the
memory half would leave the response able to blow the same ceiling.

## This is the previous fix's shadow

Bug #7 was "saved but not findable", fixed in v1.26.37 by widening the match to every
token across title, content, code and tags. That worked. It also turned queries that used
to return nothing into queries that return everything, which is how #11 appeared five days
later. Not a regression: the second defect was always there, masked by the first.

## The fix

**Bound the rows.** Twenty memories, twenty session logs, ordered as they already are.

**Send a preview, not the document.** The first 400 characters of `content`, plus
`content_length` and `content_truncated`, so the reader knows what it is holding and how
much it is not. `previous_content`, `metadata` and `embedding` are not selected at all.

**Give the reader a way back to the full text.** This is not an extra; without it,
truncation trades "too much" for "not enough". The server already answers
`GET /api/memory/:id` with the whole row, and the MCP had no way to call it: `ownmind_get`
takes a `type`, never an id. It gains an optional `id`.

**Say when the list was cut.** The response carries `total` and `returned`. A caller that
cannot tell a complete answer from a truncated one will read twenty of two hundred results
as the whole picture.

## Where the shaping lives

`shared/memory-search-result.js`, pure, used by both the online route and `mcp/offline.js`.
The offline cache search has the same unbounded shape, and this repo already put
`tokenize` in `shared/` for exactly this reason: the two code paths must not drift into
answering the same question differently.

## The response shape changes, and both consumers were checked

`GET /api/memory/search` returned a bare array and now returns
`{ data, total, returned }`.

- `mcp/index.js` already reads `Array.isArray(rows) ? rows : (rows?.data || [])`, so it
  needs no change for the shape itself.
- `client/src/pages/Portal/MemorySearchModal.jsx` does `Array.isArray(r.data) ? r.data : []`
  and would silently render an empty list. It is updated in the same release. The modal
  reads only `id`, `title`, `type` and `created_at`, all of which survive.

## Review round

Adversarial review through the `agy` CLI, against a copy outside the repo. Four findings.
Two were real defects in this change, one was my packaging error, one was half right.

- **Critical, capping `/api/session/recent` broke a second caller — correct, and the
  severity is right.** That endpoint has two callers: `ownmind_search`, which wants a few
  hits to merge with memories, and `ownmind_get('session_log')`, which is a *listing* of a
  month's work. The first version hard-coded `LIMIT 20` for both, so the listing silently
  lost most of a month. I had only looked at the search path. The limit is a parameter
  now, clamped to a ceiling so no caller can ask for an unbounded answer, with the listing
  passing 50 explicitly.
- **Important, `ownmind_get(id)` had no offline fallback — correct.** Every other branch of
  that tool degrades to the local cache when the network is gone; the branch I added sat
  outside the `try` entirely and would have thrown. It now falls back through
  `findCachedMemory`, which works because the cache holds whole memories, so the follow-up
  to a truncated search result survives an outage.
- **Minor, the SQL could not be verified — my fault, not the code's.** The `sed` range I
  used to build the review bundle grabbed the wrong region, so the reviewer never saw the
  route it was asked to check. Re-bundled and re-run.
- **Minor, no tests for the offline path — half right.** `tests/offline.test.js` was
  already updated to assert the new shape; that file was missing from the bundle, so the
  reviewer could not see it. The other half was correct: `ownmind_get(id)` had no test,
  and neither did the limit parameter. Both now do.

The pattern worth keeping: both real findings were about a **second caller I had not
looked at**. The defect was never in the code I wrote, it was in the code I did not read.

## Non-goals

- No caller-controlled page size or offset. Nobody has asked to page through search
  results, and the fix does not need it.
- No change to what search *matches*. v1.26.37's matching is correct; this is about what
  comes back.
- No semantic search. The `embedding` column stays unwritten and unread, see
  `openspec/BACKLOG.md`.
- No change to `ownmind_init`, which does not load project memories and does not need to
  now that search works.
