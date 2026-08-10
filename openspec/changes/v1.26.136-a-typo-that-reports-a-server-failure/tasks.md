# v1.26.136 — Tasks

## 1. Measure before changing anything

- [x] Sweep every endpoint on production; find `/api/memory/stats` and `/api/memory/recent`
      answering 500
- [x] Confirm from the server log that the cause is the id parameter reaching Postgres
- [x] Establish the control: a well-formed but absent id (`999999`) already answers 404
- [x] Check the other five routes that take the same parameter — same behaviour
- [x] Check the other routers for the same shape — they do not have it

## 2. Tests first

- [x] 8 cases against `parseMemoryId`: a plain integer, a number rather than a string, a
      word, a number with anything attached (`12abc`, `12.5`, `+12`, whitespace), zero and
      negatives, empty/null/undefined, the `INT` ceiling and one past it, non-scalars
- [x] Confirmed red before the module existed

## 3. Implementation

- [x] `src/utils/memory-id.js`
- [x] `router.param('id', ...)` in `src/routes/memory.js` — one gate, not six

## 4. Verify the guard actually fires

- [x] Against a real server on a real Postgres, not a fake: all four bad paths answer 404,
      `999999` answers 404, `1` answers 200
- [x] Mutant — delete the gate's `return res.status(404)` → all four go back to 500
- [x] Restored from a file backup; re-verified

## 5. Code review round

Four Important, no Critical. All four confirmed by measurement before being accepted.

- [x] **Important — nothing automated tested the thing that broke.** The unit tests cover
      `parseRowId`; delete the whole `router.param` block and all 4323 still passed. The
      defect was never digit parsing, it was route registration order. Added
      `tests/e2e/route-ids.spec.mjs` (12 cases) driving a real server on a real Postgres.
- [x] **Important — `req.memoryId` was dead.** Set by the guard, read by nobody, and a trap:
      it looks like the canonical id handlers should use, so a later edit would use it in one
      handler and `req.params.id` in the others. Deleted.
- [x] **Important — the same defect survived one route in, in `/:id/revert`.** `history_id`
      comes from the body and goes to an INT column. Measured: `{"history_id":"abc"}` → 500
      `Failed to restore memory`; `99999999999` → the same. Control: a well-formed absent id
      already answered 404. Guarded with the same helper.
- [x] **Important — "other routers do not have this shape" was too broad.** Measured:
      `PUT /api/handoff/abc/accept` → 500 `Failed to accept handoff`. No literal path is
      shadowed there so no real endpoint was failing, but the claim as written was wrong.
      Same guard applied to `handoff.js`; the sentence in the proposal narrowed.
- [x] Helper renamed `parseMemoryId` → `parseRowId` (`src/utils/row-id.js`) now that two
      routers use it
- [x] Proposal corrected: no shipped client calls the two paths that were found 500ing, so
      no feature was down. The 404-vs-400 trade-off written out rather than asserted.

## 6. Re-verify after review

- [x] Mutant A — delete the memory `router.param` → 6 of 12 e2e cases go red
- [x] Mutant B — delete the `history_id` check → 1 goes red
- [x] Mutant C — delete the handoff `router.param` → 1 goes red
- [x] Restored from file backups each time; 12/12 green

## 7. Ship

- [x] Full test suite
- [x] End-to-end suite
- [x] CHANGELOG + FILELIST + version bump
- [x] Code review
- [ ] Deploy — needs Vin. No migration; two router files plus one helper.
