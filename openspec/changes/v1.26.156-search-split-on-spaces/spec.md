# Spec — a Chinese phrase typed from memory finds it

## Requirement 1 — a token not found whole is retried as windows

### Scenario: the reported failure

- **GIVEN** a memory titled 「[團隊] 收工／交接六項自檢」
- **WHEN** the query is `收工六項自檢`
- **THEN** it matches

Four of the five two-character windows land in the title; only `工六` is broken by the `／交接`
between them.

### Scenario: what already worked must keep working

- **GIVEN** the same memory
- **WHEN** the query is `收工`, `交接六項自檢`, `收尾`, `下班`, or `wrap up`
- **THEN** it matches, through the unchanged whole-token path

### Scenario: loosening must not invent matches

- **GIVEN** an unrelated memory (`Vibe Coding 測試與版本控制`) or an iron rule
- **WHEN** the query is `收工六項自檢`
- **THEN** it does **not** match

A filter that returns the wrong memory is worse than one that returns none, because the reader
cannot tell.

## Requirement 2 — eligibility is narrow

### Scenario: which tokens qualify

| token | eligible | why |
|---|---|---|
| `收工六項自檢` | yes | CJK, four or more characters |
| `收工` | no | two characters is the phrase itself |
| `版本控` | no | three is not evidence |
| `deployment` | no | English is already split on spaces |

### Scenario: the threshold

- **GIVEN** a token yielding N windows
- **THEN** at least `ceil(N × 0.6)` must land, and never fewer than one

All of them is the exact phrase again — the thing that fails today. One of them is a
two-character coincidence anywhere in a long document.

## Requirement 3 — windows apply to prose only

### Scenario: identifier columns are excluded

- **GIVEN** a query eligible for windows
- **THEN** the window match runs against `title` and `content`
- **AND** never against `code` or `tags`

`IR-003` and `trigger:commit` are identifiers. A partial match on one means nothing.

### Scenario: counted per column

- **GIVEN** two windows in the title and one in an unrelated paragraph of the content
- **THEN** neither column reaches the threshold on its own, so the memory does not match

## Requirement 4 — online and offline stay one rule

`shared/memory-search-tokens.js` (offline) and `src/utils/memory-search-query.js` (online SQL)
MUST express the same rule. The shared module exists for this.

### Scenario: the SQL

- **GIVEN** an eligible token
- **THEN** the WHERE clause gains
  `(SELECT count(*) FROM unnest($n::text[]) g WHERE title ILIKE g) >= T`, and the same for
  `content`
- **AND** the windows go in as one array parameter, each element LIKE-escaped

### Scenario: parameter numbering

- **GIVEN** a query mixing an eligible token and a short one
- **THEN** numbering advances by two for the eligible token
- **AND** `ORDER BY` still points at the first token's whole-phrase parameter

Pointing the title sort at the array parameter instead is a type error at query time, on the
one path no unit test can reach without a database.

## Out of scope

**A synonym table.** Measured first: 收尾 / 下班 / wrap up already match, because the standard
lists them in its own text. A table would move the burden from the author to its maintainer
and still never reach 「工作做完了」.

**Semantic search.** The schema has carried `embedding vector(1536)` and an ivfflat index
since day one, and nothing has ever written to the column. It is the only thing that reaches
「工作做完了」, and it costs money per call. Deferred 2026-08-12 on that basis.
