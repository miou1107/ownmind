# v1.26.102 — spec

## S1. Detection

### S1.1 A machine that disagrees with itself is a dead collector

GIVEN a machine with a heartbeat row written in the last 2 days
AND at least one other row on the same machine not written for 7 days or more
WHEN the sweep runs
THEN that machine is a finding, naming the tools that stopped

### S1.2 A machine whose rows all agree is not a finding

GIVEN a machine where every tool row was written within 2 days of each other's age band
WHEN the sweep runs
THEN nothing is reported for that machine

### S1.3 A machine that is entirely dark is not a finding

GIVEN a machine where every tool row is older than 7 days
WHEN the sweep runs
THEN nothing is reported, however long it has been

Rationale: a switched-off computer is indistinguishable here from a broken one.

### S1.4 An ambiguous machine produces nothing

GIVEN a machine with a fresh row and a row aged strictly between 2 and 7 days
WHEN the sweep runs
THEN nothing is reported

### S1.5 An unreadable timestamp never vouches for a machine

GIVEN a heartbeat row whose `last_reported_at` cannot be parsed
WHEN the sweep runs
THEN that row is not counted as the "something is still alive" evidence

### S1.6 A single-row machine cannot produce a finding

GIVEN a machine with exactly one heartbeat row
WHEN the sweep runs
THEN nothing is reported, because there is nothing for it to disagree with

## S2. Who is told

### S2.1 The person whose machine it is

GIVEN a new finding for user U
WHEN it is announced
THEN a broadcast targeted at U alone is written, titled `你的用量採集停了`,
naming the machine, the tools, the date they stopped, the number of days,
the fact that usage was not uploaded, and a repair

### S2.2 The admin

GIVEN one or more new findings
WHEN they are announced
THEN one broadcast targeted at the oldest `super_admin` is written, listing each
finding as `who（machine）`, longest silence first, and carrying no repair line

### S2.3 No admin does not silence the members

GIVEN there is no `super_admin`
WHEN findings are announced
THEN the per-member broadcasts are still written and the claims are still committed

### S2.4 An exempt member is never evaluated

GIVEN a member with a `usage_tracking_exemption` that has not expired
WHEN the sweep runs
THEN their heartbeat rows are excluded by the query that reads them

## S3. Saying it once

### S3.1 Nothing is announced the first time a machine is seen broken

GIVEN a machine that no earlier sweep recorded
WHEN the sweep runs
THEN the silence is recorded and no broadcast is written

Rationale: a computer switched on after a long absence shows one fresh MCP
heartbeat against several stale scanner rows until the scanner's next run — up to
two hours on Windows, and longer on battery. Announcing on sight would send an
un-snoozeable two-day notice about a machine that is fine.

### S3.2 It is announced once the confirmation window has passed

GIVEN a machine recorded by an earlier sweep more than `CONFIRM_HOURS` ago
AND it is still broken
WHEN the sweep runs
THEN it is announced

### S3.3 A second sweep inside the window is silent

GIVEN a machine recorded less than `CONFIRM_HOURS` ago
WHEN the sweep runs again
THEN no broadcast is written for it

### S3.4 An announced machine is not announced again

GIVEN a machine announced by an earlier sweep and not since resolved
WHEN the sweep runs again within `REANNOUNCE_DAYS`
THEN no broadcast is written for it

### S3.5 A machine still broken after `REANNOUNCE_DAYS` is raised again

GIVEN a machine announced more than `REANNOUNCE_DAYS` ago and never resolved
WHEN the sweep runs
THEN it is announced again

Rationale: the broadcast expires after 48 hours. Without this a machine nobody
fixed is never mentioned again, which is the state this feature was built to end.

### S3.6 A widening silence updates the record without re-announcing

GIVEN an announced, open finding
AND a further tool on the same machine has since gone stale
WHEN the sweep runs
THEN `stale_tools` is updated and no broadcast is written

### S3.7 Two overlapping sweeps announce once between them

GIVEN two sweeps evaluating the same finding concurrently
WHEN both attempt to claim it
THEN exactly one claim returns a row, and only that sweep announces

Note: this rule lives entirely in the claim statement, not in the evaluator. The
evaluator reports what is broken now; which of those to announce is settled by
the database, because that is the only participant that holds a row lock.

## S4. Recovery

### S4.1 Every tool beating again closes the finding

GIVEN an announced, open finding
AND every tool row on that machine is now within 2 days
WHEN the sweep runs
THEN the row is marked resolved

### S4.1a A sighting that healed before it was announced leaves no record

GIVEN a machine recorded but not yet announced
AND every tool row on it is now within 2 days
WHEN the sweep runs
THEN its row is deleted

Rationale: keeping it would leave a stale `first_seen_at`, and the machine's next
break would be announced immediately, skipping the window it was never observed
through.

### S4.2 Resolving ends the notice the person was sent

GIVEN a finding being resolved that recorded a `broadcast_id`
AND no other unresolved machine shares that broadcast
WHEN it is resolved
THEN that broadcast's `ends_at` is set to now, if it had not already passed

### S4.2a A shared notice survives until every machine it names is repaired

GIVEN one broadcast covering two of a person's machines
AND only the first has been repaired
WHEN the sweep runs
THEN the broadcast stays live, because the second machine's state row is already
announced and can never be claimed again — ending it would retire that machine's
only notice

### S4.2b Resolving and ending the notice are one write or neither

GIVEN a finding being resolved
WHEN the process fails between the two statements
THEN neither has taken effect

Rationale: resolving first and failing leaves a repaired machine announced for the
notice's full life, and the state row can never be re-evaluated to correct it.

### S4.2c The admin summary is not ended early

GIVEN an admin summary listing several machines
WHEN any of them is repaired
THEN the summary runs its full 48 hours

A deliberate gap: only the member notice's id is stored. The admin's copy names
several people's machines, so there is no single repair that makes it wrong.

### S4.3 A machine that breaks again is announced again

GIVEN a previously resolved finding
AND the machine disagrees with itself once more
WHEN the sweep runs
THEN it is announced as a new finding, and `broadcast_id` is cleared first

### S4.4 A machine absent from the table is left alone

GIVEN an announced, open finding
AND no heartbeat row exists for that machine at all
WHEN the sweep runs
THEN it is neither resolved nor re-announced

## S5. Failure

### S5.1 A failed broadcast leaves nothing claimed

GIVEN a new finding
WHEN writing either broadcast throws
THEN the claim is rolled back, so a later sweep finds it again

### S5.2 A failed sweep never takes the server down

GIVEN the startup sweep rejects
WHEN the server boots
THEN the failure is logged and the server continues listening

### S5.3 A failed recovery write cannot stop an announcement

GIVEN a sweep with both a machine to announce and a machine to resolve
WHEN the resolve write throws
THEN the announcement has already been written and committed

Rationale: these ran first in the first draft, and one failing write aborted the
sweep before anything was announced — every day, for as long as the bad row
existed.

## S6. Delivery

### S6.1 Every message fits what the reader is actually shown

GIVEN any message this feature writes
WHEN it passes through the delivery transform (first 5 lines joined, cut at 400 chars)
THEN the result is within the envelope, and any entry shortened carries the cut
marker rather than ending silently

Note: a long enough hostname is still shortened — `collector_heartbeat.machine` is
`VARCHAR(128)` and five entries share 400 characters. What is guaranteed is the
field order: the machine name is written first in each entry, so it is the last
thing to be lost, and a cut is always visible.

### S6.2 More findings than fit say so

GIVEN more findings than the envelope holds
WHEN either message is rendered
THEN the last line states how many were omitted and the total, and survives delivery

### S6.2a Both messages list the longest silence first

GIVEN more findings than the envelope holds
WHEN either message is rendered
THEN entries dropped by the cut are the newest problems, not the oldest

### S6.3 Dates are Asia/Taipei

GIVEN a last-beat timestamp
WHEN it is rendered
THEN it reads as the local date, not the UTC one

## S7. Schedule

### S7.1 Daily, plus once at boot

GIVEN the server starts
THEN one sweep runs immediately, and a schedule is registered for 04:00 Asia/Taipei

Rationale: this condition changes because time passed, not because anything was
uploaded, so unlike install-check alerts it genuinely needs a clock. The boot sweep is
what makes a deploy show its effect the same day.
