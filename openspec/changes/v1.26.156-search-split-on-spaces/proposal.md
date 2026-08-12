# Search split on spaces, and Chinese has none

## Why

Found during a requested end-to-end check of the product, not by a test.

```
ownmind_search("收工六項自檢")  → 0 results
ownmind_search("收工")          → found
ownmind_search("交接六項自檢")  → found
```

The stored title is 「[團隊] 收工／交接六項自檢」. Typing the phrase from memory, two
characters short of the stored form, returned nothing.

`tokenize` splits the query on whitespace. English arrives pre-tokenized — "wrap up" is two
tokens and either can match alone. **Chinese has no spaces**, so a whole phrase becomes one
token and is matched as one literal substring. The user must reproduce a contiguous run of the
stored text exactly.

The reason this matters more than an ordinary search-quality complaint: **"no results" is
indistinguishable from "you have no such memory"**, and the product's entire claim is that it
remembers. A recall system that answers "nothing" to a half-remembered phrase has failed in
the one way it cannot afford to.

## What changes

A token that is not found whole is retried as **overlapping two-character windows**.

```
收工六項自檢  →  收工  工六  六項  項自  自檢
```

Against the stored title, four of the five land; only `工六` is broken by the `／交接` sitting
in the middle. A majority threshold (60%, so 3 of 5) accepts it.

**Eligibility is narrow.** Windows apply only to tokens that contain CJK **and** are at least
four characters. Two characters is the phrase itself; three is not evidence. English is
already split on spaces and is left alone entirely.

**Only the prose columns.** `title` and `content`, never `code` or `tags`. Those hold
identifiers — `IR-003`, `trigger:commit` — and a partial match on an identifier is noise.

**Counted per column, not pooled.** Windows scattered across a title and an unrelated
paragraph of content are not evidence that either is what was asked for.

**Both paths change together.** `shared/memory-search-tokens.js` is the offline matcher and
`src/utils/memory-search-query.js` builds the online SQL; the shared file exists precisely so
the two do not drift, and the online branch is the same rule expressed as a counted `unnest`.

## What was measured before choosing this

The first instinct was a synonym table — the user asked directly about
收工 / 收尾 / 結束 / 下班 / 88 / bye. Measured against the live account first:

| query | found | why |
|---|---|---|
| 收工 | ✓ | in the title |
| 收尾, 下班, wrap up | ✓ | **the standard lists them in its own first sentence** |
| 結束, 88, bye, 要走了, 工作做完了 | ✗ | nobody ever wrote those words |

So the synonym problem is smaller than it looks — authors already enumerate their own trigger
words — and a synonym table would only move the burden from "the author must think of the
word" to "whoever maintains the table must think of the word". It could never reach
「工作做完了」. It was dropped rather than built.

## Not doing: semantic search

Worth writing down because **the infrastructure is already there and has never been
connected**:

```sql
CREATE EXTENSION IF NOT EXISTS vector;                              -- db/001_init.sql:8
embedding vector(1536),                                             -- :42
CREATE INDEX ... USING ivfflat (embedding vector_cosine_ops);       -- :111
```

Nothing writes that column. Every row's `embedding` is null and the index has been spinning on
an empty set since the schema was written. Someone designed semantic search on day one and
stopped.

It would be the only thing that reaches 「工作做完了」. It needs an embedding provider, a
backfill of every existing row, a recompute on every write, and a fallback for when it is
unavailable — and it costs money per call. Deferred on that basis (2026-08-12).

## Impact

- `shared/memory-search-tokens.js` — `isBigramEligible`, `bigrams`, `bigramThreshold`, and the
  retry inside `itemMatchesTokens`.
- `src/utils/memory-search-query.js` — the same rule as SQL. Parameter numbering now advances
  by two for an eligible token; the `ORDER BY` still points at the first token's whole-phrase
  parameter, which is the one thing here a unit test can get wrong silently.
- `tests/memory-search-cjk.test.js` — new.
- No API shape change, no migration.
