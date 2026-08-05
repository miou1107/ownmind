# v1.26.69 — A silent collector must say why, and a cursor must know whose it is

## Two defects, one shape

Both let usage disappear while every layer reports health. Both were found by hand on
2026-08-05 while diagnosing why one account received no Antigravity data.

## Defect A — `silent` has no reason

v1.26.50 already separated the honest states (`client/src/pages/System/observed-users.js`):

| state | meaning |
|---|---|
| `flowing` | heartbeat and usage rows |
| `silent` | heartbeat and **zero** usage rows |
| `not_installed` | no heartbeat, ever |
| `offline` | heartbeat exists but is stale |

That was the right split and it stops one level too early. `silent` has at least five
distinct causes, and the console cannot tell them apart:

1. the `sqlite3` CLI is missing, so Tier 2 cannot be read at all
2. the tool is not installed on that machine
3. the tool is installed but has not been used
4. the collector is reading a directory the tool abandoned (v1.26.66)
5. the machine changed account, so the cursor says the day was already reported
   (defect B)

**Measured cost.** Diagnosing one `silent` cell on one machine took an hour on
2026-08-05: a server query, a code read, a wrong hypothesis (`sqlite3` missing), and
finally an agent driven by hand on the machine itself. The answer turned out to be cause
4. Every step of that is mechanical and the collector already knows the answer at the
moment it gives up.

**The collector already computes most of it and throws it away.** `runScan` returns
`scanned` and `skipped` (v1.26.65), `readVscodeTelemetry` logs an explicit warning when
the `sqlite3` CLI is missing, and `defaultExists` distinguishes ENOENT from every other
error (v1.26.66). All of it is written to a local log file nobody reads and none of it
reaches the server.

**`collector_heartbeat.status` is a dead column.** `varchar(16)`, hardcoded to
`'active'` in both halves of the upsert at `src/routes/usage/events.js:421-428`, and
`loadClients` does not even select it. The channel exists and carries one constant.

## Defect B — the cursor does not know which account it belongs to

`~/.ownmind/cache/scanner-offsets.json` is keyed by tool and file. It records no
account, and `shared/scanners/base.js` never sees anything but the API key it posts
with.

So when a machine changes account, the new account inherits the previous account's
"already reported" state. For Tier 2 that means a day the previous account reported is
never reported again. For Tier 1 it means every byte already uploaded is skipped.
Nothing warns, and the console shows `silent`.

**Observed on TANK, 2026-08-05.** The machine's cursor reads
`antigravity.last_session_date = "2026-07-23"`. The account now configured there
(`vin-windows`, user 8) has no `session_count` row for that date or any other. User 1
does have an antigravity row for exactly `2026-07-23`, and that row cannot have come
from user 1's own machine, whose abandoned directory is frozen at `2026-05-18` and whose
live directory was unreadable by the collector until v1.26.66.

Three facts line up; the account history that would confirm it was not inspected, so
this is stated as the leading explanation and not as proof.

## What this change does

1. Every adapter reports **why** it produced nothing, as a small enumerated reason.
2. The scanner sends the reason with the heartbeat.
3. The server stores it, and stops hardcoding `status = 'active'`.
4. `loadClients` returns it and `observedUsers` attaches it to the `silent` state.
5. The cursor file records which account it belongs to, and a change of account starts a
   fresh cursor rather than silently inheriting one.

## The one policy decision, and the default taken

When a machine changes account, does the new account receive that machine's earlier
usage?

**No.** The new cursor starts at the current end of the data rather than at zero.

A usage tracker's job is attribution. Replaying a machine's history into whoever holds
the credentials now would move one person's work onto another person's name, which is a
worse failure than the missing days this change exists to fix. Starting at "now" loses
no future day and claims no past one.

A first-ever install still starts from zero. The distinction is a *change* of account on
a machine that already had one, not the absence of a cursor.
