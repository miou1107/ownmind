# v1.26.87 follow-ups — Proposal: three guards that had quietly stopped guarding

## Background

These three landed while shipping the install-check alerting in
`openspec/changes/v1.26.87-install-check-alerts/`. Each was found by tripping over it, not
by looking for it, and each has the same shape as the defect that release exists to remove:
**a check that stopped checking, and whose silence is indistinguishable from success.**

### 1. The rule sync read the wrong shape and then destroyed the cache

`GET /api/memory/type/iron_rule` answers with `{ data: [...] }`. Three consumers read it;
only one was updated when the envelope appeared in some v1.19.x release:

| consumer | state before this change |
|---|---|
| `hooks/ownmind-iron-rule-check.js` | fixed in v1.19.20, with the comment still in place |
| `hooks/ownmind-iron-rule-check.sh` | throws `TypeError` on every run, output swallowed by `$( )` |
| `hooks/ownmind-git-pre-commit.js` | silently resolves to zero rules |

The pre-commit case is the dangerous one. It read the body as `Array.isArray(x) ? x : []`,
so every sync produced zero rules — and then **wrote that emptiness over the cache**. Its
caller treats "no rules" as "nothing to check" and `process.exit(0)`s, printing nothing.

So one stale-cache refresh disarmed every iron rule for the following commit, and the only
visible signal was the absence of the usual `all N rules passed ✓` line.

Observed directly on 2026-08-06: deleting the cache and running the hook produced a 2-byte
`[]` cache and exit 0 with no output. After the fix, the same steps produce 27 rules.

The `.sh` variant matters because it is the one wired into a real installation's
`settings.json` — so the PreToolUse iron-rule reminder had been producing nothing at all
since the envelope appeared.

### 2. The credentials repair existed only as a log line nobody reads

`resolve-credentials.cjs` has reported `background_safe: false` since v1.26.82 — the key was
found in the process environment and nowhere else, so the MCP works while the scheduled
scanner and the SessionStart hooks, which cannot inherit that environment, get nothing.

The only consequence was one line in the usage scanner's own log file. The install/upgrade
self-check collected the flag and never looked at it, so no report ever said so — on a
machine whose scanner had already gone quiet, in a log only that scanner writes.

Vin, 2026-08-06, on whether to repair it automatically: 「那就做吧」, with the condition that
it must not be silent and must be possible to turn off.

### 3. Two invisible characters that any editor could silently rewrite

`self-check.cjs` carried a literal U+FEFF inside a regex character class. It worked, but a
single "normalise invisible characters" editor pass would change the check's meaning while
the diff looked like nothing at all. `src/routes/debug.js` had already shipped two literal
NUL bytes for the same reason (see the sibling change).

## Decisions

| question | decision |
|---|---|
| how to fix the parse | one shared helper both Node consumers import, rather than a fourth hand-written copy |
| what to do when a sync returns nothing | never overwrite a populated cache — a stale cache still enforces something, an empty one enforces nothing |
| repair env-only credentials? | yes, automatically, but announced on the upgrade screen and with an opt-out marker |
| how loud is an opt-out? | `warn`, never `fail` — v1.26.87 broadcasts new `fail` items, so a deliberate choice must not nag |
| how loud is a failed repair? | `fail`, so it reaches a human through the new alerting |

## Scope

**In:** the shared parse/cache helper and both Node consumers; the `.sh` consumer;
`ensure-key-file.cjs` plus its self-check item and its four installer call sites; the U+FEFF
escape; widening the source-text guard to `scripts/install-helpers/` and `hooks/` and adding
an invisible-character check.

**Out:** `hooks/ownmind-usage-scanner.js` still only logs when it sees `background_safe:
false`. With the repair running from four installers and from every self-check, reaching
that branch now means refused-or-opted-out, which is not worth escalating.

## Risks

- **Writing a key to disk.** Judged acceptable because a normal install already writes it
  there; this only brings an env-only machine in line. The genuine risk is overriding a
  deliberate choice, which the opt-out marker and the printed line address.
- **The cache rule could mask a real emptying.** If someone deletes all their iron rules,
  the hook keeps enforcing the last known set until a non-empty sync replaces it. Preferred
  over the alternative, which is silently enforcing nothing.
