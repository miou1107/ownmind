# v1.26.137 — Tasks

## 1. Measure before changing anything

- [x] Reproduce: 14d and 30d answer 502 on three consecutive calls; 7d answers 200
- [x] Read the server log; find 413 from every provider behind the switch
- [x] Measure the request body per range: 32,372 / 47,893 / 52,842 bytes
- [x] Find the ceiling by bisection against the real switch, paced at 20 s: 39,600 passes,
      41,025 refused
- [x] Discard the first, unpaced bisection — its non-monotonic result was rate limiting,
      not size
- [x] Break the payload down by section to see where the bytes are

## 2. Tests first

- [x] 13 cases on `condenseSections`, written around what must survive rather than around
      the size: every project with friction still has friction, every compliance row with a
      violation is kept, the stale version is the one that survives the collapse, entries
      are shortened rather than deleted, a second pass changes nothing further
- [x] A budget test pinning the real 7-day size, so a future tightening cannot silently
      start condensing the range that always worked
- [x] Confirmed red before the module existed

## 3. Implementation

- [x] `src/lib/narrative-condense.js`
- [x] `buildRequestBody()` extracted in `llm-narrative.js`, used by both the size check and
      the request itself
- [x] Route condenses before building messages; response carries what was condensed

## 4. Verify against real data and the real upstream

- [x] Production data through the condenser: 7d untouched; 14d loses only the compliance and
      version sections, friction intact; 30d truncates friction to 250 characters with all 62
      entries and all 12 projects kept
- [x] Condensed payloads posted to the real switch: both 14d and 30d return a complete report
      (summary, 4 insights, 4 next actions, friction for 6 projects). Not "it got smaller" —
      "it produces the report"
- [x] Mutant A — route skips the condensing → 2 route tests red
- [x] Mutant B — remove the last-resort trim → 1 red
- [x] Mutant C — response omits what was condensed → 1 red
- [x] Restored from file backups; 24/24 green

## 5. Ship

- [x] Full test suite
- [x] End-to-end suite
- [x] CHANGELOG + FILELIST + version bump
- [ ] Code review
- [ ] Deploy — needs Vin. No migration.
