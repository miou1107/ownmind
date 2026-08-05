# v1.26.37 — Bug #7: improve memory keyword search (option B) + retire "semantic" claims (option C)

## One-Line Summary

`GET /api/memory/search` used a single-term `ILIKE '%q%'` over only `title` and
`content`, so multi-word or concept queries missed obviously relevant memories
(the visible face of Bug #7 "saved but can't find"). This change tokenizes the
query, ANDs the tokens, extends the match to `tags` and `code`, ranks results,
and drops the aspirational "semantic search built in" wording that never
matched the implementation.

## Why

Bug #7 root cause diagnosis:

- DB has `embedding vector(1536)` + ivfflat index (`db/001_init.sql:42,111`),
  but no code anywhere generates embeddings — the write path in
  `src/routes/memory.js:1047` INSERTs without the `embedding` column, so every
  memory has `embedding = NULL`.
- No embedding provider integration exists (no OpenAI/Voyage/Anthropic embed
  calls, no pgvector distance operators).
- `/search` (`src/routes/memory.js:864`) is pure `ILIKE '%q%'` on `title` OR
  `content`. Multi-word queries need the whole phrase to appear as a substring;
  concept queries never match; tag-only or code-only hits are invisible.
- Multiple user-facing strings promise "semantic search built in" (session-start
  tips in `mcp/index.js:229`, tool description text in `src/routes/memory.js`
  `INSTRUCTIONS_SOP`, README). This misleads users into blaming the search when
  the real gap is a missing feature.

Real "semantic" search (option A: embed on save + pgvector cosine query) is a
much bigger change — needs an embedding-provider decision, a budget, and a
backfill job for existing memories. Deferred to a follow-up (backlog note in
project memory).

## Fix (option B — keyword search improvements)

`src/routes/memory.js` `GET /search`:

- Split `q` on whitespace into tokens (trim, drop empties, cap at ~10 tokens to
  bound query size).
- For each token, match if it appears (case-insensitive) in ANY of:
  `title`, `content`, `code`, or any element of `tags::text`.
- AND across tokens (all tokens must appear somewhere in the row).
- Empty `q` after tokenization → return 400 as before.
- Add a lightweight rank: rows whose `title` contains the first token sort
  above rows that only match on `content`/`tags`/`code`; then `updated_at
  DESC` as tiebreaker.
- Preserve existing `user_id` + `status = 'active'` scope. No new response
  fields, no breaking shape change for callers.

## Fix (option C — retire "semantic" claims)

- `mcp/index.js:229` session-start tip: rewrite to describe what it actually is
  (multi-keyword search, matches title/content/tags/code).
- `src/routes/memory.js` `INSTRUCTIONS_SOP` (around line 294): drop the
  "semantic query" phrasing.
- README (all three languages) + docs: retire the "semantic search built in"
  bullet where it appears; state keyword search + note that concept search is
  on the roadmap.
- `mcp/index.js` `_offline_notice` string that says "semantic search not
  available offline" is now misleading (semantic wasn't available online
  either); rewrite to describe the actual offline degradation.

## Non-goals

- No embedding provider integration. No `embedding` column population. No
  pgvector query. Those belong to option A, tracked in a project memory as
  Bug #7-A follow-up.
- No change to `/search` response shape (each row is still a full memory).
- No change to `ownmind_search` MCP tool signature.

## Guard against regression

- Extend `tests/memory-search.test.js` (or a new focused file) with RED tests
  covering: multi-token AND, tag hit, code hit, case-insensitive, title rank
  above content, empty-after-tokenize 400. (Written before the impl per IR-003
  TDD.)
- Extend `tests/no-hardcoded-names-in-output.test.js` scope-adjacent — no new
  guard needed; the semantic-string cleanup is one-time content edit + covered
  by the new search behavior tests indirectly.

## Release

Standalone tag `v1.26.37` + kkvin.com deploy. Bug #7-A backlog memory saved.
