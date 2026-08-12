# Tasks

## 1. Find it, then characterise it

- [x] Found during a requested end-to-end product check, not by a test:
      `ownmind_search("收工六項自檢")` → 0 results, while `收工` and `交接六項自檢` both find it
- [x] Read `tokenize` rather than guessing — it splits on `\s+`, which is a language assumption
- [x] Confirm the offline path has it too (same shared module, same result)
- [x] Confirm this is **not** what v1.26.141 fixed — that release was about push-versus-pull
      instructions, not about how the query is matched

## 2. Measure before choosing a fix

- [x] Test the user's own synonym list against the live account: 收尾 / 下班 / wrap up already
      match, because the standard lists them in its own first sentence; 結束 / 88 / bye /
      要走了 / 工作做完了 do not, because nobody ever wrote those words
- [x] Conclude the synonym table is treating the symptom — it moves the burden from the author
      to its maintainer and can never reach 「工作做完了」. Dropped rather than built.
- [x] Check what semantic search would actually take, and find the schema already carries
      `vector(1536)` + an ivfflat index with **nothing ever writing to the column**

## 3. The fix

- [x] `isBigramEligible` — CJK, four characters or more
- [x] `bigrams` — overlapping two-character windows
- [x] `bigramThreshold` — 60%, floor of one
- [x] `itemMatchesTokens` retries with windows, prose columns only, counted per column
- [x] The same rule as SQL in `buildSearchWhere`, windows as one escaped array parameter

## 4. Tests

- [x] The reported query matches; the three that already worked still do
- [x] Two unrelated memories still do **not** match — the whole risk of loosening a filter
- [x] Eligibility boundaries: 2, 3, 4 characters, and English
- [x] The threshold is a majority, not all and not one
- [x] SQL shape: prose columns only, no `code`, no `tags`
- [x] `ORDER BY` still points at the first token, with numbering advanced past a window array
      — the one thing here a unit test can otherwise get wrong silently
- [x] Full suite

## 5. Release

- [x] CHANGELOG / FILELIST / three READMEs / package.json
- [x] Commit, push, tag `v1.26.156`

## Verified where, and where not

The builder is a pure function, so its shape is checked without Postgres. **That Postgres
agrees with it is not checked here** — the counted `unnest` runs for the first time on deploy,
and that is the thing to watch when this ships.

## Deferred, with the reason on the record

Semantic search. It is the only thing that reaches a query like 「工作做完了」, and the
groundwork is already in the schema. It needs an embedding provider, a backfill, a recompute
on every write, and a fallback for when it is unavailable — and it costs money per call.
Deferred on cost, 2026-08-12.
