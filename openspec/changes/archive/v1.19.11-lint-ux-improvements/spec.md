# v1.19.11 — Lint UX improvements spec

## 1. Approach A: narrative memory skips keyword matching

### Scenario 1: write project memory containing the string `random-password.js` → not blocked

**GIVEN** a type=project memory write request, content containing `shared/random-password.js`

**WHEN** POST `/api/memory`

**THEN**
- HTTP 200, write succeeds
- Not blocked by detectSecretLike's keyword detection

### Scenario 2: write project memory containing a real key pattern → still blocked

**GIVEN** type=project memory content containing `sk-proj-abc123XYZdef456ghi789jkl`

**WHEN** POST `/api/memory`

**THEN**
- HTTP 400, blocked by regex detection (pattern matching still runs)

### Scenario 3: write iron_rule containing the word `password` → not blocked (existing behavior)

**GIVEN** type=iron_rule write, content containing `不要 commit password 進 git`

**WHEN** POST `/api/memory`

**THEN** 200, not blocked (backward compatibility, existing behavior)

### Scenario 4: write memory (regular memory) containing the word `password` → still blocked

**GIVEN** type=memory or a type not on the narrative list, content containing a sensitive keyword

**WHEN** POST `/api/memory`

**THEN** 400, still goes through the original keyword detection

---

## 2. AI self-annotation

### Scenario 5: on block, the instruction text contains the "please add an annotation at the start" requirement

**GIVEN** session_id=X has violated IR-036, accumulated to the 4th time

**WHEN** the hook blocks and writes the instruction text to stderr

**THEN** the stderr content contains:
- The phrase "the rewrite must start with an annotation block"
- A markdown quote-format example (`> ⚠️ 上一版違反 IR-XXX`)
- A divider example (`---`)

### Scenario 6: the instruction text does not enforce verification of AI annotation

**GIVEN** the AI receives the instruction and rewrites, but does not add an annotation

**WHEN** the next hook run

**THEN**
- No second block (the hook cannot see whether the AI's rewritten content follows the instruction, it can only trust)
- No extra "did not comply" record is written

---

## 3. Tiered display

### Scenario 7: 1st block, full annotation

**GIVEN** session_id=X reaches BLOCK_THRESHOLD (4th violation), `block_count_in_session=0`

**WHEN** the hook blocks

**THEN** the stderr content contains the full message:
- The list of violated rule codes
- The violated-word list
- The rewrite-format example
- The annotation requirement (including a markdown quote example)

### Scenario 8: 2nd-3rd block, short message

**GIVEN** session_id=X, `block_count_in_session=1` or `2`

**WHEN** the hook blocks

**THEN** the stderr content contains a short message:
- "↻ 上版違反 IR-XXX、已被指示重寫"
- Does not repeat the violated-word details (avoids fatigue)

### Scenario 9: 4th block, reaches the downgrade limit, downgrade to warning

**GIVEN** session_id=X, `block_count_in_session=3`

**WHEN** the hook processes

**THEN**
- exit code = 1 (warning, not block)
- stderr contains the full warning message: "reply-lint 連續擋下 N 次、降警告避免死循環"
- block_count is no longer incremented

---

## 4. Structured block record

### Scenario 10: on block, write one row to reply-lint-events.jsonl

**GIVEN** a hook block event

**WHEN** after the stderr write is processed

**THEN** `~/.ownmind/logs/reply-lint-events.jsonl` appends one JSON row:
```json
{
  "ts": "<ISO8601>",
  "session_id": "<sid>",
  "event": "blocked" | "downgraded_to_warning",
  "rule_codes": [...],
  "violated_words": { "ir036_jargon": [...], "ir037_mixed": [...] },
  "violation_count_in_session": <int>,
  "block_count_in_session": <int>,
  "downgraded_to_warning": <bool>,
  "ai_instructed_to_annotate": <bool>
}
```

### Scenario 11: the record file auto-rotates over 5MB

**GIVEN** `reply-lint-events.jsonl` size > 5MB

**WHEN** the hook is about to write a new row

**THEN**
- Rename the current file to `reply-lint-events.jsonl.old`
- The new row is written into an empty `reply-lint-events.jsonl`
- The old .old file is kept for lookup

### Scenario 12: a record write failure does not block the main flow

**GIVEN** disk full / permission issue, write fails

**WHEN** the hook processes

**THEN**
- The block message is still written normally to stderr (for Claude)
- The log write failure is only recorded in logger.warn, no exception is thrown
- The exit code still returns 2 or 1 according to the block logic

### Scenario 13: no record is written when not blocked

**GIVEN** the AI response passes lint, no block needed

**WHEN** the hook finishes

**THEN** `reply-lint-events.jsonl` gets no new data

### Scenario 14: a downgrade-to-warning event is also recorded

**GIVEN** the session has been blocked 3 times in a row, the 4th is downgraded to warning

**WHEN** the hook processes

**THEN** record one row with `event: "downgraded_to_warning"`, `downgraded_to_warning: true`
