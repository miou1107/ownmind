# Name everything that matched

## Why

v1.26.154 gave the hook line a once-an-hour listing: the names of the memories that matched,
under the counts. It had each caller strip `iron_rule` out of that listing, because the ⚠️
banner underneath already prints those and the same list twice, thirty lines apart, reads as
two different findings.

What that produced, reported by the owner on 2026-08-13 after living with it for a day:

```
[OwnMind v1.26.159] Memories found: Team standards 8/32, Iron rules 2/4, Coding standards 0/0, …
  Team standards: config-placement-rule, 寫入/部署要驗證落地, 不要 blind edit, …
```

Every category with a match names it — except the one that matters most, which shows `2/4` and
nothing else. Read down the block and iron rules look like the category that found nothing. The
question asked was literally "why does it print the team standards but not the iron rules".

The reasoning in v1.26.154 was not wrong about duplication. It was wrong about what the listing
is for. The listing answers *what did OwnMind find*; the banner is not an answer to that
question, it is what stops you. Different jobs, and the overlap is not waste.

## What changes

**All three callers pass every category through, iron rules included.** One line each in
`ownmind-edit-reminder.js`, `ownmind-iron-rule-check.js`, and `ownmind-render-context.js`. The
renderer never had an opinion — it lists whatever it is handed — so nothing in `shared/` needed
to change beyond the comment that described the old rule.

**The banner is untouched.** Same box, same codes, same "first line must be this" contract.

**A test, which is the part worth having.** The exclusion was three lines in three files and
**nothing asserted it**. It could be deleted without a single red — which is how a decision
turns into an accident nobody can date. `tests/names-include-iron-rules.test.js` runs all three
callers against a stub server and asserts the rule appears in the listing *and* in the banner.
Checked against the previous commit: three of its four cases fail there.

All three, because "two of the three were updated" is the defect this project has now found six
times in a week.

## Impact

- `hooks/ownmind-edit-reminder.js`, `hooks/ownmind-iron-rule-check.js`,
  `hooks/ownmind-render-context.js` — one line each.
- `shared/hook-context.js` — comment only.
- `tests/names-include-iron-rules.test.js` — new.
- The hourly window, the counts line, and the banner are unchanged.
