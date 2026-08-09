# v1.26.102 — Nobody is told when a collector goes quiet

`openspec/BACKLOG.md` item 4. It was proposed once before, as an alert, and Vin rejected
that framing on 2026-08-05: an alarm is not a cure. Two releases went out to cure it
instead — v1.26.65 fixed seven mechanisms that let a Windows collector die and stay dead,
and v1.26.79 put a schedule repair on the auto-update path so it would reach machines that
nobody bootstraps by hand.

**Both shipped, and a machine measured today is still silent.** That is what changed, and
it is the whole argument for building the alert now: it is not a substitute for the cure,
it is the thing that says when the cure did not arrive.

## What the table says today

Every heartbeat row on production, 2026-08-07:

```
who               machine            tool          last beat   days
Amiee Kuo         LAPTOP-RGE2HCSQ    claude-code   08-07 10:24   0.2   ← the MCP
Amiee Kuo         LAPTOP-RGE2HCSQ    cursor        07-27 09:18  11.2   ← the scanner
Amiee Kuo         LAPTOP-RGE2HCSQ    antigravity   07-27 09:18  11.2
Amiee Kuo         LAPTOP-RGE2HCSQ    opencode      07-27 09:18  11.2
```

Her last actual usage event is 94 days old. Her MCP is on 1.26.57 and her scanner stopped
at 1.26.26 — both older than the release that carries the repair, so v1.26.79 never ran on
that machine and cannot.

The other ten machines in the table have every tool row written **within the same second**.
Freshest and stalest are identical for all of them. Only the broken one disagrees with
itself.

## Why "no heartbeat for N days" is the wrong rule

Two programs write `collector_heartbeat`, and they share rows:

| writer | beats for | uploads usage |
|---|---|---|
| `mcp/index.js` | one tool, the IDE that started it | no |
| `hooks/ownmind-usage-scanner.js` | all five, from a schedule | **yes** |

So when the schedule dies the person keeps heartbeating daily and keeps uploading nothing.
A rule that asks "has this person reported recently" scores that machine as healthy. It is
exactly the twenty-day blind spot that opened this backlog item.

The signal is **disagreement inside one machine**: something beat in the last two days,
something else has not beaten in seven. On the snapshot above that fires once and stays
quiet about the other ten.

## Decisions

**Who is told: both.** Vin, 2026-08-07. The person gets a message addressed to them,
naming their machine and carrying the repair. The admin gets a separate message listing
everyone, with no repair line because they cannot run it on somebody else's computer. One
neutral wording would have served neither.

**A person who is also the admin receives both.** Accepted rather than special-cased: the
two messages answer different questions, and a rule that suppresses one of them is a rule
that can suppress the wrong one.

**Nothing is announced the first time a machine is seen broken.** A computer
switched on after a fortnight away has one fresh MCP heartbeat and several stale
scanner rows until the scanner's next run: half an hour on macOS and systemd,
**two hours on Windows**, and longer on a laptop that Task Scheduler defers
because it is on battery. Announcing on sight would send an un-snoozeable two-day
notice about a machine that is fine — and the startup sweep runs at deploy time,
which is during the working day. A finding must survive six hours, which costs a
real one a single night against an incident that ran twenty days.

**A machine still broken a fortnight later is raised again.** The notice expires
after 48 hours and the state row stays announced, so without this a machine
nobody fixed is never mentioned again — the exact state this feature exists to
end.

**Repairing it ends the notice early.** The broadcast is un-snoozeable and runs 48 hours,
matching install-check alerts. Without storing which broadcast was sent, somebody who fixes
their machine within the hour keeps being told about it in the first sentence of every
conversation until it expires. `collector_silence_alert_state.broadcast_id` is what lets
the next sweep end it.

**Members with a tracking exemption are excluded in the query, not after it.** Their usage
is uncounted by agreement, so a dead collector on their machine is not a fault anybody
needs telling about.

**The repair in the message is "re-run the installer", not the path to
`ensure-scanner-schedule.sh`.** That helper ships from v1.26.79 onward, and a machine
frozen for weeks is precisely the one that never received it.

## What this deliberately does not detect

**A machine where everything went quiet.** In this table that is indistinguishable from a
computer that is switched off, a person on leave, or a laptop that was replaced. On the
same snapshot, Joanna's whole machine had been silent 4.2 days and Michelle's older Mac
1.2 days; neither is a fault, and neither has anything the person could act on. Guessing
here buys one more detection and spends the reader's trust in every other message. Recorded
in `openspec/BACKLOG.md` rather than approximated.

**A machine where the scanner never ran once.** There is no frozen row to notice. That is
what the install self-check is for.

## What the review changed

A reviewer walked the spec scenario by scenario against the first implementation
and found three defects, all of which reproduced:

1. **One broadcast covers both of a person's machines, and repairing the first
   ended it.** The second machine's state row stays announced, so it can never be
   claimed again — its only notice disappeared because a different machine was
   fixed. Michelle and Vin-windows-test both run two machines. Ending a notice now
   requires that no *other* machine sharing it is still unresolved.
2. **Resolving and ending the notice were two separate writes, in the order that
   cannot self-heal.** Resolved-then-crash leaves a repaired machine announced for
   the notice's full life with no path back, because a resolved row is never
   re-evaluated. They are one transaction now.
3. **The detail-update statement had no test and no execution path in one.**
   Swapping its two parameters would have sent a timestamp into a text column
   every sweep — and because those writes ran *before* the announcing, the whole
   sweep would have aborted daily before anybody was told anything. The statement
   is gone: the sighting upsert refreshes `stale_tools` as a side effect of
   recording, so there is one statement instead of two and no branch that can go
   untested. The recovery writes now run after the announcing.

That third one prompted the larger change: **which findings are new is no longer
decided in JavaScript at all.** `evaluateSilence` reports what is broken now; the
claim statement decides what to announce. Two overlapping sweeps compute identical
findings, so the only participant that can settle it is the one holding a row lock.

The reviewer also found that the fake database restated the confirmation window
and the re-announce interval as its own constants, so setting `CONFIRM_HOURS` to
zero in the source changed nothing any test could see. The fake imports them now,
and the values themselves are pinned by the properties they exist to satisfy: the
window must outlast the slowest scanner schedule (120 minutes, Windows) and stay
under the gap between sweeps; the re-announce interval must exceed the notice's
own 48-hour life and fall well short of the twenty-day incident.

## Verification that is not in the test suite

The tests cover the evaluator, both messages, and the job against a fake database. Two
things a fake cannot vouch for were run against the real one, each inside a transaction
that was rolled back, with the table confirmed absent afterwards:

1. **The migration parses and creates what it claims.** `\d` on the created table showed
   the unique key, the partial index, and both foreign keys, including `broadcast_id
   INTEGER … ON DELETE SET NULL` against `broadcast_messages.id`, which is `INTEGER` and
   not `BIGINT`.
2. **The sighting and claim statements behave as designed.** Run in sequence
   against the real table: just seen → claimed **0**; after the window → claimed
   1; same day again → **0**; fifteen days on → 1; once resolved → **0**; and a
   fresh sighting after resolution cleared `announced_at`, reset `first_seen_at`
   and reopened the row.

The second matters because the job test's fake implements those rules itself.
Deleting the claim's `WHERE` clause from the real SQL once left every behavioural
test green — both ends of that interface are ours, so the test proved only that
the two fakes agree. The suite now also reads the statements, and says plainly in
the test that reading is weaker than running.

Fourteen mutations were run across the two rounds. All fourteen fail a test; the
four that initially survived were real gaps and each is covered above.
