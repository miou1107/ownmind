# v1.26.64 — Tasks

Legend: `[ ]` pending · `[x]` done

Server, MCP and console. No schema change, no migration.
TDD flow: failing tests before source, then docs, then the quality gates.

## Phase 0 — Reproduce and inventory (done during design)

- [x] Reproduced live: `ownmind_search("Claude Desktop 多帳號切換 OSS")` returned three
      memories in full, one of them thousands of words
- [x] `GET /api/memory/search` is `SELECT *` with no `LIMIT` (`src/routes/memory.js:886`)
- [x] `SELECT *` drags `previous_content` (the archived prior version of every edited
      memory), `metadata` (an iron rule's whole `origin_context`, including the user
      quote) and `embedding`
- [x] `buildSessionRecentQuery` is `SELECT * FROM session_logs` with no `LIMIT`
      (`src/lib/session-query.js:18`), and `ownmind_search` merges it into the same
      response
- [x] `mcp/offline.js` `localSearch` returns every cached match, unshaped
- [x] Consumers: `mcp/index.js:898` and `client/src/pages/Portal/MemorySearchModal.jsx:34`.
      The modal reads only `id`, `title`, `type`, `created_at`
- [x] `ownmind_get` takes `type` and `parent_id`, never an id, so truncation without a
      new way back to the full text would trade one defect for another
- [x] Anti-over-design three questions run: concrete reporter, concrete harm, and the
      minimum is cap plus preview plus a fetch-one path

## Phase 1 — RED (failing tests before any source change)

- [x] `tests/memory-search-result.test.js` (new), Requirement 1:
  - [x] Long content truncates to `PREVIEW_CHARS`, with `content_length` and
        `content_truncated`
  - [x] Short content is returned whole, `content_truncated` false, no ellipsis
  - [x] `previous_content`, `metadata`, `embedding` are absent from the result
  - [x] An unknown extra column is also absent, proving the shape is allow-list not
        deny-list
  - [x] `total` versus `returned` when the list is cut and when it is not
  - [x] Empty input returns `{ data: [], total: 0, returned: 0 }`
  - [x] Null / non-array input does not throw
- [x] `tests/session-query.test.js` — extend for Requirement 3: the built SQL carries a
      `LIMIT` and an explicit column list, not `SELECT *`
- [x] Run; confirm they fail for the right reason

## Phase 2 — GREEN (shared + server)

- [x] `shared/memory-search-result.js` (new) — `shapeSearchResults`, `PREVIEW_CHARS`,
      `SEARCH_ROW_LIMIT`
- [x] `src/routes/memory.js` — explicit column list, `LIMIT`, a count over the same
      predicate, response `{ data, total, returned }`
- [x] `src/lib/session-query.js` — explicit column list and `LIMIT`
- [x] Tests pass

## Phase 3 — GREEN (MCP)

- [x] `mcp/index.js` — `ownmind_get` gains optional `id`; `type` no longer required;
      neither present is an error naming both
- [x] `mcp/index.js` — `ownmind_search` description says results are previews and names
      `ownmind_get` with an id as the way to read one in full
- [x] `mcp/offline.js` — `localSearch` goes through the shared shaper

## Phase 4 — GREEN (console)

- [x] `client/src/pages/Portal/MemorySearchModal.jsx` — read the object shape. Without
      this the modal renders an empty list against a successful response

## Phase 5 — Docs and version

- [x] `package.json` → `1.26.64`
- [x] `CHANGELOG.md`, `FILELIST.md`, `README.md` three-locale check
- [x] Note in the release that Bug #11 is the shadow of Bug #7's fix, not a regression

## Phase 6 — Quality gates

- [x] `npm test` — full suite, zero failures
- [x] `cd client && npm run build` — exit 0
- [x] Adversarial review through the `agy` CLI, against a copy outside the repo
- [x] `superpowers:receiving-code-review`
- [x] `superpowers:verification-before-completion`
- [ ] Verify against production by running the same query that reproduced it, once
      deployed. Read-only, so unlike the broadcast dialog this one can be checked live

## Out of scope

- Caller-controlled page size or offset
- Any change to what search matches; v1.26.37's matching stays
- Semantic search and the `embedding` column
- `ownmind_init`'s memory selection
