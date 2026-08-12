# v1.26.146 — Tasks

## 1. Establish what is actually stored

- [x] Confirm all seven placeholder-shaped standards have fragments, not just the two the
      issue opened by hand (135, 143, 152, 161, 183, 210, 345 — 119 fragments, 35,962 chars)
- [x] Measure the largest single standard: 210, 27 fragments, 14,091 chars
- [x] Measure what the list-all path costs today: 32 rows, 38,108 chars of content
- [x] Confirm a fragment can carry empty content (152's front-matter row hashes to the
      SHA-256 of the empty string)
- [x] Confirm fragment titles carry the full breadcrumb path and `metadata.level` the depth
- [x] Measure the read itself before designing around it: 0.25–0.33 s per standard, 0.27–0.32 s
      to ask the server whether anything changed, ~0.25 s of both is connection setup

## 2. Adversarial review of the design, before writing code

- [x] agy (Gemini 3.1 Pro High) against a non-git bundle, `git status` clean afterwards
- [x] A second reviewer on a different model, per Vin
- [x] Verify every finding against the source before acting on it. Survived: the cap was
      above the ceiling it guards; the `content`-safety rationale named a consumer that does
      not exist; id ordering breaks on a heading rename; the offline path repeats the defect;
      `details` collides with an existing key. Did not survive: "a disabled standard shows its
      owner an empty list" — the owner branch of the predicate short-circuits parent status,
      confirmed against a real database in §5.

## 3. Tests first, watched failing

- [x] Watched the whole file fail before `src/utils/standard-fragments.js` existed
- [x] `buildStandardFragments` — order by `ord`, fall back to id, shuffled fixtures throughout
- [x] `ord: 0` is a position, not a missing value
- [x] Empty and null content kept, not dropped
- [x] Budget: under returns all; over truncates, declares it, and names the follow-up call
- [x] An oversized first fragment is returned whole, not sliced and not dropped
- [x] The budget counts title as well as content
- [x] The exported production constant is asserted, not only an injected one
- [x] Route wiring: `team_standard` with fragments gets the field; without fragments gets no
      field; six other types trigger no query at all; parameters bound the right way round
- [x] A `standard_detail` read alone carries its parent id and sibling count
- [x] Mutation-tested — seven mutations, seven caught:
      sort removed (4 red) · `ord || id` (2) · content sliced to budget (2) ·
      type condition widened (2) · parameters swapped (1) · budget → Infinity (1) ·
      empty fragments dropped (1)

## 4. Implementation

- [x] `src/utils/standard-fragments.js` — shaping, ordering and budget, no DB access
- [x] `GET /api/memory/:id` attaches `fragments`, `fragments_total`, `fragments_returned`,
      `fragments_truncated` and, when truncated, the notice naming the follow-up
- [x] `POST /batch-sync-standard` writes `metadata.ord` on insert, on update, and on a row
      whose text is unchanged but whose position moved (`stats.reordered`)
- [x] Reuse `buildReadableWhere` rather than writing a second visibility predicate
- [x] `content`, `PUT /:id` and the batch-sync response shape left alone

## 5. Verify against something real

- [x] Real Postgres (pgvector/pgvector:pg16, the image the project deploys), schema from
      `db/*.sql`, seeded with both shapes, three users and an opt-out row. Eleven checks, all
      green: document order beats id order · empty section survives · disabled fragment
      excluded · non-owner reads shared fragments · opted-out member reads none · no-`ord`
      standard falls back to id · self-contained standard yields nothing · owner still reaches
      a retired standard's fragments · non-owner does not · malformed `parent_id` matches
      nothing instead of aborting · non-numeric `ord` does not abort the ordering
- [x] Full suite: 4,615 pass, 0 fail (13 live-database checks after review, not 11)

## 6. Both ends (IR-022)

- [x] `mcp/index.js` `ownmind_get` description no longer asks the reader to tell two shapes
      apart
- [x] `hooks/lib/render-session-context.js:94` needs no edit — the instruction it already
      gives becomes true under this change, which is the point
- [x] Admin console: no consumer. `client/src` calls `/api/memory/search` and
      `/api/memory/type/project` and never `PUT`s a memory
- [x] `hooks/lib/conditional-sync.js` unaffected — it syncs by type, never by id
- [x] `stats.reordered` is passed through opaquely by the MCP upload handler

## 7. Review

- [x] `superpowers:requesting-code-review` — see §10
- [x] `superpowers:receiving-code-review` — see §10
- [x] `superpowers:verification-before-completion`

## 8. Release paperwork

- [x] `package.json` → 1.26.146
- [x] README
- [x] FILELIST — `src/utils/standard-fragments.js` and the test file
- [x] CHANGELOG, referencing issue #89
- [ ] Do not tag, push or deploy without Vin (IR-136) — and say plainly that nothing reaches
      anyone until kkvin.com is rebuilt

## 9. Deliberately not done

- [x] The seven placeholder rows are not rewritten and no data is backfilled
- [x] `POST /batch-sync-standard` keeps creating the same parent row
- [x] Local-first reads are deferred with the measurement recorded, not guessed. Before that
      is ever switched on, `generateSyncToken` must include `standard_detail`: today it hashes
      `MAX(updated_at)` over `team_standard` rows only, so re-syncing a standard's text leaves
      the token unmoved and every machine would serve a stale copy believing it current.
- [x] The duplicate-breadcrumb twin (two chunks sharing a title both insert on first sync;
      later syncs dedupe by title so one is never updated and never disabled) is pre-existing
      and out of scope. Noted because `fragments` would surface such a row.

## 10. Code review, and what it changed

- [x] `superpowers:requesting-code-review` — a reviewer on a second model, given the commit
- [x] `superpowers:receiving-code-review` — every finding checked against the source first

Acted on:

- [x] **The truncation notice pointed at a call that returns the document backwards.**
      `GET /type/standard_detail?parent_id=` ordered by `updated_at DESC`, and the reorder
      branch stamps `NOW()` row by row, so the first re-sync of a standard leaves that call
      returning it in reverse. The escape hatch would have committed the defect the ordinals
      exist to prevent. That branch now orders by `ord`; the unnarrowed listing keeps
      newest-first. Both verified against the real database.
- [x] **The proposal described an offline line the code did not contain**, while the new tool
      description promised the whole standard unconditionally. Implemented: a cached
      `team_standard` now says its sections are not in the local cache and must not be treated
      as complete.
- [x] **The sync branches had no tests at all.** Extracted to `planChunkSync` and covered by
      nine cases; five mutations watched to fail, including deleting the reorder branch
      (legacy standards then never gain ordinals) and guarding it on truthiness (position 0
      never backfills).
- [x] **`spec.md` named `details_*` fields** the code does not have, and specified a console
      flow that does not exist. Rewritten against `fragments_*` and `ownmind_update`, with
      scenarios added for the escape hatch and the three sync branches.
- [x] `SIBLING_COUNT_SQL` had no parameter-order assertion where its sibling did; added, and
      the swap mutation now fails.
- [x] Softened the "all one or all the other" claim: the sync loop is not a transaction.
- [x] Recorded that `stats.reordered` counts the whole standard on the first post-deploy sync,
      and that a fragment-lookup failure now fails the read rather than degrading to the row.

Found by the review and fixed rather than worked around:

- [x] `tests/memory-visibility.test.js` asserted inside a 2,600-byte window, and eight new
      lines above the guard pushed it out — a red test about nothing that had changed, the
      same failure the file's own `ownmindGetBlock` was rewritten to avoid. Now slices to the
      next `case`. Re-checked by removing the guard: still red.

Not acted on: the duplicate-breadcrumb twin (pre-existing, §9) and the uncapped escape hatch
for a standard large enough to exceed the budget — capping it would leave no recovery path at
all, and nothing on the account is within 5,000 characters of the budget.
