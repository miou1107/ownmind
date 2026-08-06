# v1.26.87 — Spec

## ADDED Requirement: a failure is identified by machine and check, not by report

A failure SHALL be keyed by `(user_id, machine, check_name)`. Every decision about whether
to announce something is made against that key.

`install_check_alert_state` holds one row per key, with `first_seen_at`, `announced_at` and
`resolved_at`.

### Scenario: the same red light in ten consecutive reports

- **GIVEN** `(Adam, LAPTOP-MBGGLV2J, memory_load)` has been announced
- **WHEN** nine further reports arrive, each still failing that check
- **THEN** no further broadcast is created

The upgrade flow uploads several reports per run — `install_started`, `post_install`,
`upgrade_complete`. Announcing per report would produce three copies of one problem.

### Scenario: fixed, then broken again

- **GIVEN** an announced failure whose key later appears with `status: 'pass'`
- **WHEN** that report is evaluated
- **THEN** `resolved_at` is set and no broadcast is created
- **AND** if the same key fails again afterwards, it is announced again

Silence about recovery is deliberate; re-arming is not. A regression is news.

### Scenario: the same check fails for a different stated reason

- **GIVEN** an announced failure whose key later reports a different `detail`
- **THEN** no new broadcast is created, and the stored `detail` is updated

The key is deliberately the check, not its wording. Self-check messages get rewritten
between releases; re-announcing on every rewording would make every upgrade look like a new
outbreak.

### Scenario: a failure that predates this release

- **GIVEN** `install_check_logs` holds reports that were never evaluated
- **WHEN** the evaluator runs for the first time
- **THEN** every currently-failing key is treated as new and announced once

The two-month-old WSL failures are the reason this release exists; they must surface rather
than be grandfathered into silence.

## ADDED Requirement: only the latest report per machine decides current state

For each `(user_id, machine)`, the evaluator SHALL read the most recent report **that
carries a `checks` array** and treat it as the current state of that machine.

### Scenario: beacon rows do not clear a failure

- **GIVEN** the newest row for a machine is an `install_started` beacon with no `checks`
- **AND** the row before it reported `scheduler: fail`
- **THEN** `scheduler` is still considered failing

Beacons are emitted before the checks run. Letting one count as "no failures present" would
mark every problem resolved at the start of the next upgrade.

## ADDED Requirement: only `fail` is announced

Checks with `status: 'warn'` SHALL NOT produce a broadcast and SHALL NOT be written to the
state table.

### Scenario: a warn-only report

- **GIVEN** a report whose checks are 9 `pass` and 1 `warn`
- **THEN** no broadcast is created

## ADDED Requirement: identical failures across machines are one line

New failures SHALL be grouped by `(check_name, detail)`. One group renders as one entry
listing every affected person and machine.

### Scenario: six machines, one WSL bash

- **GIVEN** six machines newly failing `memory_load` with the same `detail`
- **THEN** the message contains one entry for `memory_load`, naming all six machines
- **AND** not six entries

Vin's words in the backlog: 「6 machines, same WSL bash」 must read as one row, not six.

### Scenario: same check, different cause

- **GIVEN** two machines failing `scheduler` with different `detail` strings
- **THEN** they render as two entries

## ADDED Requirement: the message is enough to act on without opening anything

Each entry SHALL carry the check name, the affected people and machines, the `detail`
string, the `fix` string when the report supplies one, and the client version.

### Scenario: the entry for Adam's machine

- **GIVEN** the failing check
  `{name: 'memory_load', status: 'fail', detail: 'memories have never loaded…', fix: 'Re-run the installer…'}`
  reported by Adam on `LAPTOP-MBGGLV2J` at `1.26.84`
- **THEN** the rendered entry contains `memory_load`, `Adam`, `LAPTOP-MBGGLV2J`, the detail
  text, the fix text and `1.26.84`

## ADDED Requirement: truncation is stated, never silent

Broadcast bodies are capped at 2000 characters. When the rendered entries do not fit, the
message SHALL include the count of entries omitted.

### Scenario: more failures than fit

- **GIVEN** rendered entries exceeding the cap
- **THEN** the body ends with a line stating how many entries were left out
- **AND** the body is at most 2000 characters

A cut that does not announce itself reads as "that was everything", which is the defect this
release exists to remove.

## ADDED Requirement: the message is written to fit what the reader is shown

Both delivery paths — `hooks/lib/render-session-context.js` and `mcp/index.js` — reduce a
broadcast body with `body.split('\n').slice(0, 5).join(' ').slice(0, 400)` before the reader
sees it. The rendered message SHALL fit that envelope: at most 5 lines, and at most 400
characters once those lines are joined with single spaces. Each entry SHALL occupy exactly
one line, and when entries are left out the footer SHALL be the last line.

2000 characters is what the server stores. 400 is what the reader receives.

### Scenario: two failures, one delivery

- **GIVEN** two entries rendered into the body
- **WHEN** the delivery transform is applied
- **THEN** both check names and both machine names are present in the result

### Scenario: the footer is what survives, not what is cut

- **GIVEN** more entries than fit
- **WHEN** the delivery transform is applied
- **THEN** the omitted-count sentence is present in the result

Rendering to the 2000-character storage cap while the reader is shown 5 lines and 400
characters reproduces the exact defect this release exists to remove: entry 2 onward, and the
sentence saying how much was left out, never arrive.

### Scenario: an entry too long for its share

- **GIVEN** one entry whose text exceeds the room available to it
- **THEN** that entry is shortened with a visible marker
- **AND** no footer is rendered when nothing was actually omitted

## ADDED Requirement: the broadcast reaches Vin and only Vin

The broadcast SHALL be created with `type='announcement'`, `severity='warning'`,
`is_auto=TRUE`, `allow_snooze=FALSE`, `target_users=[<oldest super_admin id>]` and
`ends_at = now + 48 hours`.

`severity='warning'` is load-bearing: `hooks/lib/render-session-context.js` injects the
action-required block for warnings, so the AI raises it in its first reply rather than
rendering it passively.

48 hours, not seven days, follows from that: a warning that cannot be snoozed and has no
session-start cooldown leads the AI's first sentence in every new conversation until it
expires. Two days of that is a reminder. A week of it is something the reader learns to
scroll past, which is the same silence this release exists to break.

### Scenario: no super_admin exists

- **GIVEN** the users table has no `super_admin`
- **THEN** evaluation records state as usual but creates no broadcast, and logs the reason

Matches `nightly-upgrade-reminder`'s existing behaviour rather than inventing a second rule.

## ADDED Requirement: nothing is marked announced without a broadcast to show for it

The evaluator SHALL claim each new failure before writing the broadcast, SHALL put in the
broadcast exactly the failures it claimed, and SHALL perform every claim and the broadcast
insert inside a single database transaction, so that either all of them are visible or none
of them are.

A claim is a conditional upsert that only matches a row whose `announced_at` is NULL or whose
`resolved_at` is set, and it returns the rows it matched. A key that returns nothing was
claimed by somebody else.

Undoing the claims from the client is not sufficient and SHALL NOT be relied on. A claim can
commit on the server while the response back to the client is lost; the client then believes
that claim failed, holds no record of it, and undoes nothing, leaving the key marked announced
forever. Only the server can decide that outcome, which is what ROLLBACK is.

### Scenario: the broadcast write fails

- **GIVEN** new failures have been claimed
- **WHEN** the broadcast insert raises
- **THEN** the transaction rolls back, leaving no key marked announced by this run
- **AND** the error propagates to the caller
- **AND** the next sweep announces those failures

Recording state first and broadcasting second means one transient pool timeout silences those
failures permanently — the two-month-old WSL failures again, this time caused by us.

### Scenario: a claim fails partway through the loop

- **GIVEN** several new failures, the first of which has already been claimed
- **WHEN** a later claim raises
- **THEN** the transaction rolls back, so the earlier claim is not visible either
- **AND** the next sweep announces every one of those failures

A claim that lands and is then followed by a failing claim is the same defect one statement
earlier: nothing was announced, yet that key reads as announced from then on.

### Scenario: a rollback leaves other runs' announcements alone

- **GIVEN** a key announced and committed by an earlier sweep
- **WHEN** a later sweep rolls back
- **THEN** that earlier key keeps its `announced_at`

A rollback undoes this transaction's writes and nothing else. Re-opening a key somebody else
announced would announce the same problem twice.

### Scenario: no super_admin exists

- **GIVEN** new failures have been claimed and there is no recipient
- **THEN** the transaction commits the claims and creates no broadcast

No recipient is not a failure. Rolling the claims back here would make every later sweep
re-evaluate the same failures forever.

### Scenario: two sweeps run at once

- **GIVEN** two sweeps that both read the state table before either writes to it
- **THEN** exactly one broadcast is created between them

The second sweep's conditional upsert waits for the first transaction to commit and then
matches nothing, so it has nothing to announce. Every upload runs a sweep inline, so two
uploads arriving together is the normal case, not an exotic one.

### Scenario: two sweeps claim the same keys in the same order

- **GIVEN** two sweeps whose new failures overlap
- **THEN** each claims them ordered by `(user_id, machine, check_name)`

Inside a transaction a claim holds its row lock until commit, so two sweeps taking the same
keys in opposite orders would deadlock and Postgres would kill one of them. The natural order
is the client's uploaded `checks` array — an order decided outside this server. Sorting by the
key takes that decision back.

### Scenario: resolutions and detail updates are not part of the pair

- **GIVEN** a sweep with resolutions or detail changes to record
- **THEN** those updates are written outside the announce transaction

They touch keys nobody is about to announce, each one stands alone, and they must still run on
the common path where nothing new is failing and no transaction is opened at all.

## ADDED Requirement: recency comes from the server, not the client

`DISTINCT ON (user_id, machine)` SHALL pick the newest report by `install_check_logs.id`.

### Scenario: a machine with a skewed clock

- **GIVEN** a machine that uploads a passing report carrying a `ts` a year in the future
- **WHEN** it later uploads a failing report
- **THEN** the failing report is the one that decides that machine's current state

`ts` is whatever the client put in the payload and is only validated as parseable. Ordering by
it lets one wrong clock silence a machine forever, silently. `id` is assigned by the database
and only goes up.

## ADDED Requirement: alerting never costs a report

Evaluation SHALL run after the `install_check_logs` insert has committed, and any error it
raises SHALL be caught and logged.

### Scenario: the evaluator throws

- **GIVEN** `POST /api/debug/install-check` with a valid body
- **AND** evaluation raises
- **THEN** the response is still `200`
- **AND** the row is present in `install_check_logs`

### Scenario: startup sweep failure does not stop the server

- **GIVEN** the startup sweep raises
- **THEN** the server still serves requests

## ADDED Requirement: `src/routes/debug.js` is plain text

The file SHALL contain no bytes in `\x00-\x08` or `\x0e-\x1f`.

### Scenario: the file is searchable

- **WHEN** `grep -c install-check src/routes/debug.js` runs
- **THEN** it reports a non-zero count

Two raw NUL bytes at lines 73 and 81 make `file` report the source as `data` and make `grep`
skip it as binary, so a search of `src/` for the route's own path comes back empty.
