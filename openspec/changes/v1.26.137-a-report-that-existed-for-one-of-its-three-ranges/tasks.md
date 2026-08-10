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

## 5. Code review round

Five Important, no Critical. Each confirmed by running it before being accepted.

- [x] **Important — the size that was checked excluded the notes.** They are attached after
      the last measurement, so the posted body is larger than the number that was approved:
      the reviewer measured 37,882 checked against 38,835 posted. That is the same defect
      this change is about, one layer in. The notes are now part of every measurement after
      the initial fit check.
- [x] **Important — the notes could contradict themselves.** Reproduced: 100 friction rows
      at a 3,000-byte budget produced "共 100 則，未刪除任何一則" sitting beside
      "只保留前 5 列，另外 95 列沒有列出". Fixed structurally rather than by editing the
      string: the notes are now derived from the before/after state instead of accumulated
      per step, so a note describing an undone step is unrepresentable.
- [x] **Important — the prompt never mentioned `_condensed`.** The model was handed a
      compliance section containing only violations with nothing telling it so, and the
      obvious output is "鐵律遵守狀況不佳，多數規則都被違反" — a confident false claim in a
      report the prompt itself says the analysed people will read. Rule 10 added. Verified
      against the real model: it now opens with "這裡只列出有違反或跳過的 7 條紀錄" and used
      no "大部分/多數/普遍" anywhere in that section.
- [x] **Important — the page never rendered `condensed`.** The API returned it and nothing
      read it, so a summarised AI paragraph sat beside a complete statistics table with
      nothing explaining why they disagree. Rendered above the report; i18n key added to all
      three locales.
- [x] **Important — `fits === false` was discarded.** Now logged with the byte count, so the
      next failure is one log line rather than a request replayed by hand from the server.
- [x] **Minor — an unreadable version could erase a real one.** `scanner_version` is
      nullable and arrives as null or "unknown" in production. Reproduced: a machine
      reporting 1.26.135 and null collapsed to null, blanking the answer the section exists
      to give. A parsable version now always wins.
- [x] **Minor — the last resort trimmed time-ordered lists from the wrong end**, dropping the
      most recent days. Those lists now keep their tail.
- [x] **Minor — notes spliced internal key names into text a manager reads.** Mapped to
      words.
- [x] **Minor — "全部遵從" was the wrong description** of the dropped compliance rows: an
      observed-only row has every counter at zero and is not compliance. Reworded.
- [x] **Minor — the budget comment misdescribed its own margin.** `requestBytes` already
      counts the system prompt, so prompt growth is measured, not absorbed.

## 6. Re-verify after review

- [x] Mutant A — measure without the notes → the invariant test goes red. The first version
      of that test was not sensitive enough to catch it (the overshoot happened to stay
      inside the budget for that fixture); rewritten to assert the invariant directly
- [x] Mutant B — let an unreadable version win → 1 red
- [x] Mutant C — notes back to internal key names → 3 red
- [x] Real production data again: 7d untouched, 14d and 30d inside the budget
- [x] Condensed payloads posted to the real model again: both ranges return a complete
      report, and the compliance paragraph states its own scope
- [x] Client build passes (the page reads a key that has to exist)

## 7. Ship

- [x] Full test suite
- [x] End-to-end suite
- [x] CHANGELOG + FILELIST + version bump
- [x] Code review
- [ ] Deploy — needs Vin. No migration.
