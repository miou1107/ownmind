# Spec — v1.26.171 rules actually selected, and heard

## 1. Trigger arrays select rules

GIVEN a rule tagged `trigger:respond` and a compliance check whose trigger is `['respond','report']`
WHEN `selectRules` runs
THEN the rule is selected (any element of the array may match).

GIVEN a rule tagged `trigger:deploy` and the same array trigger
WHEN `selectRules` runs
THEN the rule is not selected.

GIVEN a string trigger `'respond'` (legacy callers)
WHEN `selectRules` runs
THEN behaviour is unchanged from today.

## 2. Always rules survive the budget

GIVEN 7 `trigger:always` rules and 26 tag-matched rules, with `maxRules: 6`
WHEN `selectRules` runs
THEN all 7 always-rules are selected — the count budget never evicts a rank-0 rule, even
when rank-0 rules alone exceed it (only the char budget may drop one, and that drop is
recorded) — AND the dropped list records every tag-matched rule that did not fit.

## 3. Switched off is never silent

GIVEN the server answers `outcome:'skipped'` with `enabled:false`
WHEN `runComplianceStep` finishes
THEN it returns a notice telling the user this turn was NOT checked because enforcement is
switched off for the account — not silent `none`.

GIVEN no apiKey or apiUrl on the machine
WHEN `runComplianceStep` finishes
THEN it returns a notice that the machine has no credentials and the turn was NOT checked.

## 4. The block path carries the check id

GIVEN a violation with `check_id` 42
WHEN the blocking stderr is produced
THEN it contains the id 42 and the 誤判 instruction (`誤判 42`), so the user can dispute
from the rewritten reply they actually see.

## 5. Notices render on the user's screen

GIVEN any notice-producing branch of the reply-lint Stop hook (cap reached, not-checked,
warn-mode heads-up)
WHEN the hook exits 0
THEN stdout is a single JSON object whose `systemMessage` carries the notice text
AND `/dev/tty` is never opened
AND the same text is appended to the audit spool.

GIVEN the blocking branch (exit 2)
WHEN the hook exits
THEN stderr carries the rewrite instruction exactly as before (that channel is the model's,
and it already renders to the user as the block reason).

## 6. State notices are throttled; event notices are not

GIVEN the same not-checked state (e.g. server outage) persists across turns
WHEN turns pass
THEN the notice renders on the turn the state begins, every 10th turn while it persists,
and once when the state clears — and every occurrence, spoken or suppressed, is appended
to the audit spool.

GIVEN an event notice (a violation pushed back, the retry cap reached)
WHEN it occurs
THEN it always renders, never throttled.
