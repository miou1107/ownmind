# v1.19.11 — Lint UX improvements: fewer false positives + dual-display reason annotation + self-learning data foundation

## Background

After v1.19.7-10 landed, Vin found three experience problems during use:

### Problem 1: writing project memory easily trips the keyword detector

The `detectSecretLike` detector introduced in v1.19.1 uses substring matching to catch English sensitive words like `password`, `token`, `secret`, `credential`.

But when writing type=project memory, you inherently reference a lot of:
- Code file names (`random-password.js`, `admin-password-reset.js`)
- Internal spec folder names (`v1.19.9-password-recovery`, `v1.19.10-credential-hygiene`)
- Database column names (`must_change_password`, `api_key`)

These all trip the detector, the write gets blocked, and the user is forced into awkward rewording.

### Problem 2: after a block the AI rewrites, the user sees two similar passages and doesn't know why

After the reply-lint hook accumulates violations to the 4th time it calls `process.exit(2)`; Claude receives the stderr rewrite instruction and just writes a new version, without self-annotating "I was just blocked".

User experience: two similar passages, feels like the AI is repeating itself.

### Problem 3: blocked events have no structured record

Currently events rely on `~/.ownmind/logs/YYYY-MM-DD.jsonl` to write compliance events, but the structure is "a compliance report for the server to collect", not "a block record for the user to look up".

Without a structured record:
- There's no way to count "how many times I was blocked this week, which rule I violate most"
- There's no way to auto-suggest "rule X has a high false-positive rate, should we adjust it"
- The backend dashboard data source is incomplete

## Improvement scope

### 1. Fewer false positives (approach A)

In the write flow of `src/routes/memory.js`, expand the types that get `skip_keyword: true` from the existing `iron_rule` / `principle` to all narrative types:

- `iron_rule`, `principle` (existing)
- `coding_standard`, `team_standard` (newly added)
- `project`, `portfolio`, `session_log` (newly added)

Pattern matching (regex) and the length heuristic still run and can block genuinely high-risk patterns (WordPress, JWT, GitHub PAT, AWS, OpenAI keys).

### 2. AI self-annotation (soft hint, best-effort)

Change `formatBlockReason` in `hooks/ownmind-reply-lint.js`; add to the instruction text a requirement that "the rewrite must start with a quoted annotation":

```markdown
> ⚠️ **上一版違反 IR-036（行話沒附白話）、重新調整：**
> 沒附白話的詞：routes, password

---

[新回應內容]
```

The AI is not verified for compliance (we accept an 85% follow-through rate). When it fails, the record is the backstop.

### 3. Tiered display (avoid user fatigue)

| Nth block | Instruction text content |
|---|---|
| 1st | Full annotation: violated rules + violated-word list + rewrite hint |
| 2nd-3rd | One-line note: "↻ 上版違反 IR-036、已重寫" |
| 4th (reaches the downgrade limit) | Full warning + downgrade-to-warning hint |

The hook needs to know "which block this is within the session", using the `block_count` field of the existing `session-counter.js` (introduced in v1.19.7).

### 4. Structured block record (log backstop + self-learning foundation)

Add `~/.ownmind/logs/reply-lint-events.jsonl`; write one line per block event:

```json
{
  "ts": "2026-05-22T14:25:33.000Z",
  "session_id": "abc123",
  "event": "blocked",
  "rule_codes": ["IR-036", "IR-037"],
  "violated_words": {
    "ir036_jargon": ["routes", "password"],
    "ir037_mixed": ["refactor", "codebase"]
  },
  "violation_count_in_session": 4,
  "block_count_in_session": 1,
  "downgraded_to_warning": false,
  "ai_instructed_to_annotate": true
}
```

This record paves the way for the following features (v1.20+):

- Personal stats: "how many times I was blocked this week, which rule I violate most"
- False-positive suggestions: "IR-XXX was blocked 50 times, 80% of which the user immediately bypassed"
- Rule optimization: "a word keeps getting blocked, should we add a whitelist"
- Cross-tool continuous record: all OwnMind clients share the same record

## Out of scope

- ❌ Auto-applying optimization suggestions (only in v2.0; at this stage only record, do not actively change rules)
- ❌ Machine-learning false-positive recognition (not enough data, leave for v2.0+)
- ❌ Forcing the AI to annotate (we accept it not being done, no fights)
- ❌ Touching the existing compliance-event jsonl (keep backward compatibility)

## Effort estimate

| Item | Lines |
|---|---|
| Approach A (change skip_keyword scope in src/routes/memory.js) | 5 lines |
| AI self-annotation instruction rewrite | 20 lines |
| Tiered display logic | 30 lines |
| Structured block record | 50 lines (new file + integration) |
| Aligning existing tests | 30 lines of changes |
| New tests (tiering, record, fewer false positives) | 80 lines |
| Trilingual README + CHANGELOG + FILELIST | 200 lines |
| openspec | 200 lines |
| **Total** | ~620 lines |

Engineering time: ~3 hours (including tests + full run + commit).

## Risk checkpoints

- [ ] `npm test` fully green (cases added after v1.19.10)
- [ ] Approach A: write one project memory containing the string `random-password.js`, confirm it is not blocked
- [ ] AI annotation: run dogfood, see whether the actual Claude rewrite follows the annotation format
- [ ] Tiered display: trigger 4 times in a row, confirm the 1st / 2nd-3rd / 4th display styles differ
- [ ] Log backstop: after a block event, check that `reply-lint-events.jsonl` has a new record
- [ ] The existing reply-lint tests are not broken (the existing v1.19.3 / v1.19.7 cases should all stay green)
