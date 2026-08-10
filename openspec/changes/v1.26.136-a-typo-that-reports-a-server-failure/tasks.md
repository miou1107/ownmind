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

## 5. Ship

- [x] Full test suite — 4323 passed, 0 failed
- [x] End-to-end suite — 41 passed
- [x] CHANGELOG + FILELIST + version bump
- [ ] Code review
- [ ] Deploy — needs Vin. No migration; the change is one router file plus a new helper.
