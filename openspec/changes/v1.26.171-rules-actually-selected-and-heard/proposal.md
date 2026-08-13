# v1.26.171 — the rules are actually selected, and the system is actually heard

## Why now

A full-evening measured audit (2026-08-13, benchmark corpus of 80 real replies, adversarially
reviewed twice) found the per-turn enforcement pipeline failing at three independent places.
Each one alone is enough to make a stored rule silently unenforced; together they explain the
incident that started the audit ("the rule was delivered and still not enforced").

1. **Selection: 6 of 310 rules ever reach the judge.** The Stop hook sends
   `trigger: ['respond','report']`; `matchesTag` in `src/lib/enforcement/select-rules.js`
   interpolates the array into one template string (`trigger:respond,report`), which matches
   no tag. Only the 7 `trigger:always` rules survive, and the `maxRules` budget then drops the
   highest id. Measured on the live bundle: 310 selectors, 6 judged per turn.

2. **Silence impersonates a pass.** `outcome:'skipped'` (the server saying "enforcement is
   switched off for this account") is treated exactly like a clean verdict, and a machine with
   no credentials returns silent `none`. The product principle says a check that is off must
   never be indistinguishable from a check that passed.

3. **Nothing the system says reaches the human.** Every user-facing notice goes through
   `/dev/tty`, which can never be opened from a Claude Code hook (no controlling terminal on
   any platform — verified against the hooks documentation and by direct test). The fallback
   spool is flushed into a stream nobody reads. On this user's machine the spool holds three
   "showing you instead of asking again" notices that were never seen. The documented working
   channel is JSON on stdout with a `systemMessage` field.

## What changes

- `matchesTag` accepts a trigger array (any-of). `trigger:always` rules rank with
  `always_check` so the count budget cannot evict them.
- `runComplianceStep` returns a loud notice for `outcome:'skipped'` and for missing
  credentials, instead of silent `none`.
- The blocking stderr now carries the check id, so 誤判 feedback is possible from the block
  path (previously the id only appeared in banners nobody saw).
- All user-facing notices from the reply-lint Stop hook are emitted as
  `{"systemMessage": …}` JSON on stdout (exit 0), replacing `writeToTty` as the primary
  channel. The spool remains as an audit record only.

## Out of scope, deliberately

- The action-track PreToolUse gate, the notice-first graduation ladder, and the
  subscription-sibling judge (P1/P2 of the approved change list) — separate changes.
- Raising `maxRules` / batching: pointless while the judge is synchronous; moves with P2.
- The wrap-up-rule hook point (session end), Windows/other-assistant capability matrix.

## Evidence

Bench assets and scores: session scratchpad `bench/` (REQUIREMENTS.md, PLAN-v2.md,
labelled corpus, judge matrix). Decision list approved by Vin 2026-08-14.
