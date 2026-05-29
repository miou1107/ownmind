# v1.19.11 — Lint UX improvements task list

## Scope

### Approach A: fewer false positives
- [x] Change the POST flow of `src/routes/memory.js`, expand the types that skip_keyword applies to
- [x] New test: writing project memory containing a code path is not blocked

### AI self-annotation
- [x] Change `formatBlockReason` in `hooks/ownmind-reply-lint.js`, add the annotation requirement + markdown quote example to the instruction text
- [x] New test: the stderr content contains the "please add an annotation at the start" phrase

### Tiered display
- [x] Change the hook main flow, decide the instruction-text version based on `block_count_in_session`
- [x] New test: on consecutive blocks, the 2nd-3rd message is short, the 4th downgrades to a full warning

### Log backstop
- [x] Write `hooks/lib/lint-event-logger.js` (pure function, easy to test)
- [x] Integrate into the hook main flow, append a record on block
- [x] Rotate mechanism (5MB cap)
- [x] A write failure does not block the main flow
- [x] New test: check the file content after a block

### Docs
- [x] package.json version 1.19.10 → 1.19.11
- [x] Add the v1.19.11 section to CHANGELOG
- [x] Add the new files to FILELIST
- [x] Add to the trilingual README FAQ an entry "why the AI sometimes seems to say things twice"

### Verification
- [x] `npm test` fully green
- [x] Go through superpowers:requesting-code-review
- [x] commit

## Risk checkpoints

- [x] Write a real project memory containing the string `random-password.js` successfully
- [x] Run dogfood, see whether Claude adds an annotation on rewrite
- [x] Trigger 4 times in a row, confirm the tiered display differs
- [x] Confirm `reply-lint-events.jsonl` has been written
- [x] The old reply-lint tests (v1.19.3 / v1.19.7) are all green

## Non-tasks

- ❌ Auto-applying optimization suggestions (only in v2.0)
- ❌ ML false-positive recognition (not enough data)
- ❌ Force-verifying whether the AI adds an annotation (accept best-effort)
