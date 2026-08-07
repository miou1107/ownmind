# v1.26.99 — spec

## S1. Detection

### S1.1 A machine that disagrees with itself is a dead collector

GIVEN a machine with a heartbeat row written in the last 2 days
AND at least one other row on the same machine not written for 7 days or more
WHEN the sweep runs
THEN that machine is a finding, naming the tools that stopped and the ones still beating

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

### S3.1 A second sweep is silent

GIVEN a machine announced by an earlier sweep and not since resolved
WHEN the sweep runs again
THEN no broadcast is written for it

### S3.2 A widening silence updates the record without re-announcing

GIVEN an announced, open finding
AND a further tool on the same machine has since gone stale
WHEN the sweep runs
THEN `stale_tools` is updated and no broadcast is written

### S3.3 Two overlapping sweeps announce once between them

GIVEN two sweeps evaluating the same new finding concurrently
WHEN both attempt to claim it
THEN exactly one claim returns a row, and only that sweep announces

## S4. Recovery

### S4.1 Every tool beating again closes the finding

GIVEN an announced, open finding
AND every tool row on that machine is now within 2 days
WHEN the sweep runs
THEN the row is marked resolved

### S4.2 Resolving ends the notice the person was sent

GIVEN a finding being resolved that recorded a `broadcast_id`
WHEN it is resolved
THEN that broadcast's `ends_at` is set to now, if it had not already passed

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

## S6. Delivery

### S6.1 Every message fits what the reader is actually shown

GIVEN any message this feature writes
WHEN it passes through the delivery transform (first 5 lines joined, cut at 400 chars)
THEN nothing that identifies a machine is lost to the cut

### S6.2 More findings than fit say so

GIVEN more findings than the envelope holds
WHEN the admin message is rendered
THEN the last line states how many were omitted and the total, and survives delivery

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
