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

## What the second review round changed

Two of these would have made the release a net loss.

1. **`main()` is not only the scheduler's entry point.** The self-check imports it as `scan`
   to mean "run one scan and tell me what you found", and runs it under a 60-second budget.
   Putting the upgrade inside `main()` therefore put `git pull` and `npm install` inside
   that check — and the self-check is itself spawned from `update.sh`, which is what an
   upgrade launches. On a machine eight weeks behind, the exact population this is for, npm
   alone outlasts the budget: the check times out having proven nothing, stamps its weekly
   marker anyway, and `process.exit(0)`s out of the self-check while still holding the
   update lock, which five minutes later another process reclaims as stale and starts a
   second pull into the same directory. Only a run started by the scheduler upgrades now;
   everything else just scans.
2. **The new heartbeats would have switched off the alert that finds this.**
   `evaluateSilence` detects a dead collector by disagreement inside one machine: some tools
   fresh, others frozen. That worked *because* a broken adapter stopped writing rows. As of
   this release it writes one every two hours saying it failed — so without a change there,
   every broken collector looks permanently fresh, and the machine that prompted all of
   this would show five current rows and raise nothing. A failure heartbeat now counts as an
   absence: it never makes a machine look alive, and it lands among the stale whatever its
   age. `skipped_by_config` deliberately does not, because alerting on somebody's own
   setting every two hours is how an alert gets muted.

Also fixed: a slow-but-not-wedged adapter finishing after its deadline could overwrite the
offsets the adapters behind it had committed, so the offsets write now merges onto a fresh
read rather than a stale snapshot; `releaseUpdateLock` honours the token it is given, so a
holder that overran can no longer delete its reclaimer's lock; the lock's stale threshold
went from 5 minutes to 10, because the upgrade's own worst case is 280 seconds of
legitimate work and twenty seconds of headroom is not headroom (the shell hook's copy moved
with it, and the test that says the two agree now reads both numbers instead of restating
them); the weekly marker is stamped only when the round-trip reached an answer, not when it
timed out or found another scan already running; `redactHome` reaches the encoded project
directory (`-Users-alice-SourceCode-…`) and stops at the punctuation an error message puts
after a path; and the two fire-and-forget `log()` calls got handlers, since a rejection with
none ends the process on Node 15 and later.

Two test weaknesses the review named and both are closed: the npm.cmd assertion could be
satisfied by a comment (it now strips comments first), and no test covered a `update_sh`
failure or checked that a successful upgrade stamps the day.

## What CI caught that neither review did

The deadline timer was `unref`'d, so that a finished run would not sit waiting out the
remaining minutes. `clearTimeout` in the `finally` already did that, and an unref'd timer
cannot hold the event loop open — so an adapter wedged on an awaited promise rather than on
a live handle holds nothing either, the loop drains, and the process leaves *before* the
deadline fires. The hung tool reports nothing, which is the exact silence the deadline was
written to break.

Node 24's test runner keeps its own handle alive and hid it. Node 20 said so out loud:
"Promise resolution is still pending but the event loop has already resolved". The local
suite was green and wrong, on every run, across three review rounds.

One test had to change with it: it raced a promise that never settled against the real
ten-minute default, which without the unref left a live timer nothing would clear — the run
hung for ten minutes instead of failing. It now races work that finishes in 40ms, which is
the same claim without the leak.

Both suites are now run on Node 20 as well as 24 before this is called done.

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
