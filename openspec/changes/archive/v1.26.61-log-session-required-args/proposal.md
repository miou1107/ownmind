# v1.26.61 — Stop losing whole session logs over a missing `model`

Filed by Eric on production as bug #9, severity high, component `log_session`.

## What he saw

`ownmind_log_session` refused three times with:

> missing required argument(s): tool, model. These fields are required but were not
> present in the tool call — received arguments: summary

`ownmind_report_compliance` succeeded twice in the same session, so it was not
connectivity or auth. Removing `details` changed nothing. The session summary was never
written, and `CLAUDE.md` requires that call before a conversation ends.

## What is actually wrong — and what is not

The message came from **our own client-side guard** (`mcp/lib/required-args.js`, v1.26.27),
and it was telling the truth: the arguments object handed to the tool really did contain
only `summary`. OwnMind did not eat the fields. They never arrived.

So the reported defect is not a defect in this code. **The defect is that we made a
recoverable situation unrecoverable.**

That guard's own header says two AIs had already filed near-identical reports — first for
`ownmind_save`, then for `ownmind_log_session`. This is the third. The guard was the fix
for the first two, and it changed the failure from a confusing server 400 into a clear
client-side error. It did not stop the failure. Eric's AI retried three times and got the
same message each time, then gave up.

A clearer error message is a reminder, and reminders do not hold. The way to end this
class is to stop requiring what we can either work out ourselves or genuinely live
without.

## The two fields are not the same kind of problem

**`tool` we already know.** `mcp/index.js:175` defines `CLIENT_TOOL` from
`OWNMIND_CLIENT_TOOL`, defaulting to `claude-code`, and already sends it as the heartbeat's
tool, as the `x-ownmind-tool` header, and as `client_tool` on bug reports. Requiring the
caller to repeat a value the process holds in a constant is asking to be told something we
know. It defaults now.

**`model` we cannot know.** There is no environment variable and no signal for it, and
inventing `"unknown"` would put a fabricated value in a column that feeds the statistics
dashboard's model distribution. So it becomes optional, and absent means NULL.

The decisive argument is the trade being made today: **requiring `model` throws away the
entire session record to protect one field of it.** The summary, the project, the turn
count, the friction points and the suggestions are all discarded because one string is
missing. Optional keeps all of it and loses only the model — which is what was missing
anyway.

`session_logs.tool` and `.model` are both nullable already (`db/001_init.sql:65-66`). The
server's `requireFields` was stricter than its own schema.

## The absence has to stay visible

`src/routes/activity.js:288` builds the model distribution with
`sessionsByModel[row.model]`, so a NULL model becomes a bucket keyed `"null"` — a chart
category named after a JavaScript coercion. That is precisely the "absence rendered as a
value" defect Requirement 7 of the console consolidation exists to prevent, and this change
would have created a new instance of it. Unreported sessions are counted under a named
bucket instead, and the same applies to `tool`.

## Second issue in the same report

Eric also noted that `ownmind_report_bug`'s `confirm_string` never says what the user must
type. The description reads "the exact submit confirmation phrase typed verbatim by the
user" and stops there. His user typed 「確認送出」, was refused with a 400, and only then
learned from the error that the phrase is 「送出」. Every first-time reporter hits this.

The phrase is withheld from the description on purpose: `GUARD_EXEMPT_FIELDS` deliberately
exempts `confirm_string` from the client guard so a misbehaving AI is not nudged into
auto-filling a human-in-the-loop gate. That reasoning is sound and stays.

**The first attempt at this fix broke it.** Writing 「送出」 into the description made the
AI able to relay it — and equally able to fill it in, which is easier than interrupting
itself to ask. Adversarial review caught it. An LLM that knows the exact string a check
wants will supply that string.

So the description carries the *route* to the phrase rather than the phrase: call, be
refused, and the refusal names the word (`src/utils/bug-report-helpers.js:22` already
does). The AI then shows the user the exact word instead of asking them to guess, which
is what went wrong for Eric's user — and the description never contains the answer.

## Found while doing it

- `compressOldSessions` builds each monthly summary line as `` `- [${s.tool}] ...` ``. A
  NULL tool renders the four characters `null` — and permanently, because that text
  replaces the rows it summarises and they are then deleted. Fixed here: it is a direct
  consequence of making `tool` nullable for API callers in this release.
- **Backlog, not fixed here**: `src/routes/activity.js:416` and `:611` group compliance
  events by `activity_logs.tool`, which its own writer already documents as
  `{string|null}`. So that grouping can already produce a `"null"` key today. Different
  table, different writer, and it predates this change, so it is recorded rather than
  swept in.

## Review round

0 Critical that survived checking. Four claims, each verified against the code first:

- **Critical, a NULL `tool` crashes `compressOldSessions` with a TypeError — refuted.**
  A template literal coerces null to the four characters `null`; it does not throw
  (`node -e` confirms). The cosmetic half was real and is fixed above.
- **Critical, `/api/session/recent` returning `model: null` breaks the weekly report —
  refuted.** `computeReportData` reads `row.details` and nothing else; it never touches
  `model`. The report query selects the column and ignores it.
- **Important, naming the confirm phrase in the description defeats the gate — correct,
  and it was my change that introduced it.** See above; the description now carries the
  route to the phrase rather than the phrase.
- **Minor, the builder and the guard disagreed about whitespace — correct, and it
  reproduced this release's own bug.** The guard and the server both count only the empty
  string as missing, with a test pinning that. The builder trimmed, so `summary: "   "`
  passed the guard, was stripped here, and reached the server without a summary: a generic
  400 in place of the clear client-side error. `summary` now uses the guard's rule
  exactly; `tool` / `model` / `machine` keep trimming, because those are defaulted here
  rather than guard-enforced. A test asserts the two agree on every value.

## Non-goals

- No change to `mcp/lib/required-args.js`. The guard is correct and stays for the fields
  that remain genuinely required.
- No backfill. Existing rows keep whatever model they recorded.
- No migration. Both columns were already nullable.
