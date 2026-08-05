# v1.26.64 — Spec

## Requirement 1 — Result shaping is one pure function, shared by both search paths

`shared/memory-search-result.js` exports `shapeSearchResults(rows, options)`, returning
`{ data, total, returned }`.

Each shaped row keeps `id`, `type`, `title`, `code`, `tags`, `status`, `tier`,
`created_at`, `updated_at`, plus `content` truncated to `PREVIEW_CHARS`, `content_length`
holding the untruncated length, and `content_truncated`. Nothing else survives: not
`previous_content`, not `metadata`, not `embedding`.

`total` is how many rows matched, `returned` is how many are in `data`. They differ
exactly when the list was cut.

It is in `shared/` because `mcp/offline.js` searches a local cache with the same unbounded
shape, and the two paths must not answer the same question differently. `tokenize` already
lives there for this reason.

### Scenario: a long memory comes back as a preview

- **GIVEN** a row whose `content` is 5,000 characters
- **WHEN** it is shaped with `PREVIEW_CHARS = 400`
- **THEN** `content` is 400 characters long
- **AND** `content_length` is 5000
- **AND** `content_truncated` is true

### Scenario: a short memory is untouched

- **GIVEN** a row whose `content` is 120 characters
- **WHEN** it is shaped
- **THEN** `content` is the original 120 characters, with no ellipsis appended
- **AND** `content_truncated` is false
- **AND** `content_length` is 120

### Scenario: the heavy columns never leave

- **GIVEN** a row carrying `previous_content`, `metadata` and `embedding`
- **WHEN** it is shaped
- **THEN** none of those three keys is present on the result
- **AND** this holds even when the caller passes a row with extra columns the function
  does not know about, because the shape is built by naming what to keep rather than by
  deleting what to drop

### Scenario: the caller can tell a cut list from a whole one

- **GIVEN** 57 matching rows and a limit of 20
- **WHEN** they are shaped
- **THEN** `total` is 57, `returned` is 20, and `data` has 20 entries
- **AND** given 12 matching rows, `total` and `returned` are both 12

### Scenario: nothing matched

- **GIVEN** an empty array
- **WHEN** it is shaped
- **THEN** the result is `{ data: [], total: 0, returned: 0 }`, not null and not undefined

## Requirement 2 — The search endpoint selects and returns a bounded set

`GET /api/memory/search` selects an explicit column list rather than `*`, applies
`LIMIT 20`, and answers `{ data, total, returned }`.

The row cap is applied in SQL, and `total` comes from a count over the same predicate, so
the caller learns the real match count without the server reading every matching row's
text.

### Scenario: a common keyword

- **GIVEN** a keyword matching 57 memories
- **WHEN** `GET /api/memory/search?q=…` runs
- **THEN** the response carries 20 rows, `total: 57`, `returned: 20`
- **AND** the largest response the endpoint can produce is bounded by
  20 × (preview + metadata), not by the size of the corpus

### Scenario: ordering is unchanged

- **GIVEN** the same query before and after this release
- **WHEN** both run
- **THEN** the first 20 rows are the same 20, in the same order: v1.26.37's
  `(title ILIKE …) DESC, updated_at DESC` is untouched

## Requirement 3 — Session search is bounded too

`buildSessionRecentQuery` selects an explicit column list and applies `LIMIT 20`.

`ownmind_search` merges memories and session logs into one response, so leaving this half
unbounded would let the same ceiling be exceeded by a different route.

### Scenario: many matching sessions

- **GIVEN** 200 session logs matching `q`
- **WHEN** `GET /api/session/recent?q=…` runs
- **THEN** at most 20 rows come back, newest first as before

## Requirement 4 — There is a way back to the full text

`ownmind_get` takes an optional `id`. Given one, it returns that single memory in full,
from `GET /api/memory/:id`, which already answers with the whole row.

`type` stops being required, because a call carrying `id` does not need it. A call
carrying neither is refused with a message naming both.

### Scenario: reading one result in full

- **GIVEN** a search result with `content_truncated: true` and `id: 692`
- **WHEN** `ownmind_get` is called with `id: 692`
- **THEN** the full `content` comes back, along with `metadata`

### Scenario: the old call still works

- **GIVEN** `ownmind_get` called with `type: 'iron_rule'` and no `id`
- **THEN** it behaves exactly as before this release

### Scenario: neither argument

- **GIVEN** `ownmind_get` called with neither `id` nor `type`
- **THEN** it returns an error naming both, rather than fetching something arbitrary

## Requirement 5 — The offline path answers in the same shape

`mcp/offline.js` `localSearch` applies the same limit and the same shaping, through the
same shared function.

### Scenario: offline search of a large cache

- **GIVEN** the local cache holds 100 memories matching the query
- **WHEN** the network is down and `ownmind_search` falls back
- **THEN** the result is shaped and capped exactly as the online one, so an AI reading it
  cannot tell which path produced it apart from the offline notice

## Requirement 6 — Both consumers of the changed response were updated

`GET /api/memory/search` returned a bare array and now returns an object.

`client/src/pages/Portal/MemorySearchModal.jsx` reads
`Array.isArray(r.data) ? r.data : []`, which would silently render an empty list against
the new shape. It is updated to read the object, and it renders only `id`, `title`, `type`
and `created_at`, all of which the shaped row keeps.

`mcp/index.js` already reads `Array.isArray(rows) ? rows : (rows?.data || [])` and needs
no change for the shape itself.

### Scenario: the console search still lists results

- **GIVEN** the periodic-report search modal with a query matching three memories
- **WHEN** it renders
- **THEN** three rows appear with their titles, types and dates

### Scenario: an older MCP client

- **GIVEN** a client still on a previous version calling the new endpoint
- **WHEN** it reads the response
- **THEN** it finds the rows through its existing `rows?.data` fallback, so the change
  does not require every installed client to upgrade first
