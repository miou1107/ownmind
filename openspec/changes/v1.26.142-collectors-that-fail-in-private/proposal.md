# v1.26.142 — Collectors that fail in private

## The observation

A member has been running the scanner on schedule since installation. The server holds
a `collector_heartbeat` row for `claude-code`, and rows for `cursor`, `opencode` and
`antigravity` left by a scanner from eleven weeks ago. It holds **no `codex` row at all**,
and never has.

The member uses Codex almost exclusively. So the one tool that would carry her usage is
the one tool the server has never heard from.

That absence is not a state the collector can produce on purpose. `runScan` sends a
heartbeat on every outcome it knows about — including the empty ones. A tool that is not
installed sends `no_install`. A tool with nothing new sends `no_new_activity`. A tool that
could not be read sends `unreadable`. Every path ends with a row.

There is exactly one way to end a run with no row: throw before `runScan` returns.

## Two holes, and what each one costs

### 1. A thrown adapter reports nothing, anywhere the operator can see it

`hooks/ownmind-usage-scanner.js` wraps each adapter in a `try/catch`. On a throw it
appends one line to `~/.ownmind/logs/scanner.log` and moves on to the next tool.

The line is correct, complete, and on the machine with the problem. Nobody is reading it.
From the server the tool is simply missing, which is indistinguishable from a member who
has never installed that tool — and that is the reading it got for weeks.

The same applies to `OWNMIND_SKIP_TOOLS`: a tool named there is dropped from the adapter
list before the loop, so it too leaves no trace off-machine.

The correct behaviour is the one the rest of the module already follows: a collector that
cannot say anything useful still says *why*. A crash is a state worth a heartbeat, not a
reason to skip the one signal that would surface it.

### 2. The check that answers this question is switched off on the only path that runs

`usage_roundtrip` exists precisely for this. It runs a scan, reads back from the server,
and compares the two per tool. Its verdict for a tool the server has no record of is
`not_recorded` — the exact answer needed here — and self-check uploads its full output.

v1.26.81 removed it from the `--quick` set, on the reasoning that scanning every local
database once a day in the background is too much for a check the scanner's own schedule
already covers.

The reasoning was sound and the consequence was not measured: `--quick` is the auto-update
path, and for a member who never re-runs the installer by hand it is the **only** path.
This member's machine has uploaded 14 checks a day for weeks, all of them about whether
things are installed, and never once the one that asks whether the data is arriving.

### 3. A machine only upgrades if somebody opens an AI tool that speaks MCP to OwnMind

Found while reading the same table. A second member's account holds five heartbeat rows,
all current to today, all reporting the version she installed on 18 June. Two
`install_check_logs` rows exist, both from install day.

The full upgrade — `git fetch`, `git pull`, `npm install`, then the sync script — lives only
in `mcp/index.js` and fires when an AI tool opens an MCP session. The two SessionStart hooks
run the sync script alone, which repairs an installation and never advances it.

She works in an editor OwnMind does not register itself with. Nothing on that machine is
broken; there has simply been nobody to ask it to update, for eight weeks, and no fix
shipped in that time could reach her — including this one.

The scheduled scanner already runs on every one of these machines, on a timer, with no AI
tool and no model involved. It is the obvious place for this and was not being used for it.

## What this changes

1. **A thrown adapter sends a heartbeat.** New reason code `adapter_error`. The row exists,
   dated, attributed to the machine, and says the collector failed rather than staying silent.
2. **A hung adapter does too.** Per-tool deadline, new code `adapter_timeout`. A throw is
   caught and reported; a scan that never returns holds the loop, starves every adapter
   behind it, and dies when the scheduler gives up. That shape is visible in the same
   member's records — the first tool current, the four behind it frozen on a date in July.
3. **The message travels with it.** The heartbeat carries an optional `error` string; the
   server truncates it and writes one `usage_audit_log` row (`collector_error`). The closed
   reason set stays closed — the free text lives in the audit table, not in a sized column.
4. **A skipped tool says so.** `OWNMIND_SKIP_TOOLS` produces a `skipped_by_config` heartbeat
   instead of silence.
5. **`usage_roundtrip` runs on the auto-update path, at most once every 7 days.** Not every
   day — the objection in v1.26.81 was about daily cost and it still holds. Weekly turns
   "never" into "within a week", with no user action of any kind.
6. **The upgrade moves to `shared/auto-update.js`, and the scheduled scanner runs it.** One
   implementation, two callers. A machine now upgrades on its own schedule regardless of
   which AI tool it hosts, or whether it hosts one at all.

## What the review round changed

Three real defects, all in the part that now runs unattended on other people's machines.

1. **An upgrade that failed after the pull reported itself healthy the next day.** `git pull`
   moves HEAD; `npm install` and the sync script can still fail. The next run then found no
   pending commits, called itself clean, stamped the day and never retried — leaving the
   machine on new code with old dependencies until somebody happened to push another commit.
   A machine reporting a healthy upgrade every day while quietly broken is the exact failure
   this release exists to remove, so it must not be introduced by it. The post-pull steps now
   have their own marker: written before they start, removed when they finish, and its
   presence means redo them regardless of what git says.
2. **A rebase stopped by a conflict wedged the machine for good.** `--rebase --autostash`
   waits for a human. There is no human. Every later pull then failed with "you are in the
   middle of a rebase" — the `--ff-only` fallback included — with the user's own changes held
   in the autostash. Now aborted before the pull and again if the pull leaves one behind;
   aborting is also what restores the autostash.
3. **The audit row was a way around the heartbeat's rate limit.** The UPSERT is throttled by
   its own `WHERE`; the new audit write ignored the result, so a machine stuck in a failure
   loop could write as often as it liked. Gated on the UPSERT having written. Because that
   statement also fires whenever the reason *changes*, the first report of a failure still
   always lands.

Two further findings were refuted by measurement rather than argument: a `Promise.race`
loser that rejects later is consumed by race's own subscription and does not become an
unhandled rejection; and the SessionStart hook cannot starve the scanner of the lock,
because its own daily marker stops it taking that lock more than once a day.

Two smaller fixes: the day is stamped before the lock is released, closing the gap in which
another program could read a stale marker and repeat the whole upgrade; and `redactHome`
matches case-insensitively, because a Windows path in a Node error and the one in
`USERPROFILE` do not always agree about case.

### Known limitation, not fixed

On Windows, `execFile` with `shell: true` and a timeout kills the shell and not the `npm`
process under it, so a timed-out `npm install` can go on writing to `node_modules` after the
lock has been handed back. Node has no portable process-group kill, and every workaround
costs more than the failure: the window is 120 seconds, on a two-hour schedule, for a
dependency install of a handful of packages. Recorded rather than papered over.

## The one thing this cannot do for itself

The member on the June version cannot receive this change, because the mechanism that
would deliver it is the thing being fixed. Her machine needs one manual upgrade; every
machine after that is self-healing.

## What this deliberately does not do

- **No new table and no migration.** `collector_heartbeat.reason` and `usage_audit_log`
  already carry both halves.
- **No fix for whatever is crashing the Codex adapter.** That failure has never been seen;
  this change is what makes it visible. Diagnosing an error nobody has read yet would be
  guessing.
- **No LLM anywhere in the detection or delivery path.** The scanner runs from Task
  Scheduler / launchd / systemd; the weekly round-trip and the upgrade run inside it. All
  plain node, on a timer, with nothing to decide.
- **No change to when the scanner runs.** The upgrade is appended to a run that was already
  happening, and deliberately after the scan: an upgrade rewrites the files the process is
  running from, and a run that finishes on the code it started with is one less thing to
  reason about.

## Why the throttle is a marker file and not a server decision

The machines this is for are the ones the server cannot reach conclusions about — that is
the whole problem. A throttle that needs a round-trip to decide whether to run the
round-trip fails closed on exactly the population it exists to serve. `~/.ownmind/.last-usage-roundtrip`
holds a date; an unreadable or missing marker means "run it".
