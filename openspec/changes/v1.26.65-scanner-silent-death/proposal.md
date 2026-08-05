# v1.26.65 — A Windows collector can die silently and report that it is healthy

`openspec/BACKLOG.md` item 4, approached from the other end. The backlog framed the
problem as "nobody is told when a collector goes quiet" and proposed an alert. Vin
rejected that framing on 2026-08-05: an alarm is not a cure. This change fixes the
mechanisms that let the collector die and stay dead instead.

## What happened

One member's usage stopped uploading on 2026-07-15 and nobody noticed for twenty days.

`~/.ownmind/package.json` is a single file, read by both the MCP and the scanner
through the same `getClientVersion()`. On that machine the MCP reads 1.26.59 today,
while the scanner's last heartbeat, on 07-15, carried 1.26.29. The files were
upgraded and the scanner has not executed once since.

The scanner's heartbeat carries no `os` field; the MCP's does. That member's only
fresh row carries `os: win32`. So it is the MCP, and the scanner is producing nothing
at all rather than running and failing. Cross-checked: `collector_heartbeat` holds
nine machine names against nine distinct users with no overlap, so the scanner is not
succeeding under some other account either.

## Seven defects, each of which turns a moment's failure into permanent silence

**1. Re-registering the scheduled task deletes before it creates.**
`register-scanner-task.ps1` ran `Unregister-ScheduledTask` and then
`Register-ScheduledTask`, under `$ErrorActionPreference = 'Stop'`. Any failure between
those two lines leaves the machine with no scheduled task, forever.

This already happened. The comments in that file record v1.17.66 shipping two
parameter names that do not exist on `New-ScheduledTaskSettingsSet`, throwing on both
PowerShell 5.1 and 7: "task 完全沒註冊", hit by two users on upgrade. The parameters
were corrected. The shape that turned a typo into permanent data loss was not.

**2. The upgrade treats a lost scheduled task as a footnote.**
`interactive-upgrade.ps1` printed `Task Scheduler re-register failed; upgrade itself
complete` and continued to a green result. The user sees a successful upgrade and has
silently lost usage collection.

**3. The result Task Scheduler records is meaningless.**
`run-hidden.vbs` called `sh.Run cmd, 0, False`. With `bWaitOnReturn` false the method
returns immediately and always yields 0, so `wscript.exe` exits 0 whether node ran,
crashed, or was never at that path. Windows records `LastTaskResult` 0, "success".

This is worse than a missing signal. The documented first step for diagnosing exactly
this fault is "check LastTaskResult, 0 means it worked", and that check cannot fail.
It would have reported a twenty-day-dead scanner as healthy.

**4. The scanner exits 0 when it cannot find its credentials.**
The MCP is handed `OWNMIND_API_KEY` in its environment by the IDE. The scanner is a
scheduled task with no environment to inherit, so it must locate and parse
`~/.claude/settings.json` itself. Two credential paths, and the component that keeps
working uses the other one. When the scanner's path breaks it logged one line to a
local file and returned normally.

This has happened too: `readCredentials` carries a comment about a BOM prefix causing
exactly this for two users, who then showed as "not installed" with zero usage. That
cause was patched; the silence was not.

**5. "I found no files" and "I could not look" were the same line.**
`defaultListJsonlFiles` wrapped everything in `catch { }` and returned an empty array,
with a comment asserting an interpretation the code cannot make: *"baseDir does not
exist: clean env, return empty"*. A missing directory, a permission failure and a
home directory resolving somewhere unexpected all came out as `sent=0`.

Defect 5 was found by being caught by it. Reading three consecutive `sent=0` scheduled
runs against a manual run that sent 169 events, this change's author concluded the
scheduled runs were failing to see data. They were not; the machine had nothing new
at those times, and the manual run happened to follow an hour of work. There was no
positive control, and the log gave no way to obtain one.

**6. One unreadable file takes the whole tool down, check-in included.**
Both Tier 1 adapters call `readIncremental` bare inside their file loop, and build the
heartbeat only after the loop completes. So a single file that cannot be opened costs
that tool its data *and* its report that it is alive, every run.

The server has been recording this and nobody was reading it: one member has **no
`codex` heartbeat row at all**, on a server where the other eight do, including members
who almost certainly never run Codex. Not using a tool cannot produce a missing row; an
adapter that throws before line 101 can.

Codex supplies a routine trigger. It moves sessions from `~/.codex/sessions` to
`~/.codex/archived_sessions`, and the adapter walks both, so a session archived between
the listing and the open is an `ENOENT` on a path that existed moments earlier. This is
the product's normal behaviour, not an edge case.

**7. One unparseable line does the same thing, and this is the better explanation.**
In the codex adapter's per-line loop, `buildEventFromTokenCount` was called unguarded,
two lines below a `try/catch` that already handles a malformed JSON line by skipping it.
That function reaches `canonicalizeCodexMaterial`, which throws on any non-finite
number. One bad `token_count` line therefore throws out of `readSince` on **every run,
forever**.

The distinction from defect 6 is what makes this the leading candidate: **"never" is not
"sometimes".** The archival race is intermittent, so across months and several scanner
versions at least one run should have got a check-in through. An adapter that has never
once produced a heartbeat, while its four siblings on the same machine have, needs a
failure that reproduces every time. A specific bad line does; a race does not.

The guarded and unguarded calls sitting three lines apart in the same loop is the whole
defect: someone already knew a bad line must not kill the scan, and only applied it to
the JSON parse.

## The fixes

- `Register-ScheduledTask -Force` replaces an existing task in one call. No window.
- After registering, confirm the task is present; exit non-zero if it is not.
- A failed re-registration now calls `Fail`, which reports to the server and stops the
  upgrade from claiming success. No rollback: the files are fine, only the schedule is
  not.
- `run-hidden.vbs` waits and propagates the real exit code, so `LastTaskResult` means
  something. The task's existing 10-minute `ExecutionTimeLimit` bounds the wait.
- Missing credentials throw, so the run ends non-zero. With the previous item, Windows
  finally shows red.
- `defaultListJsonlFiles` returns empty only for `ENOENT` and throws otherwise, which
  the per-adapter handler in the scanner turns into a visible
  `[scanner] <tool> failed: …` line.
- A file that cannot be read is skipped alone, and so is a line that cannot be turned
  into an event. The tool keeps what it could read and still sends its heartbeat, and
  the reason travels out with the result. The file offset advances past a bad line, so
  it is stepped over once rather than retried until the end of time.
- The scan log gains `files=N` and `skipped=N(CODE)`, so `sent=0 files=0` and
  `sent=0 files=37` are no longer the same sentence, and a skip that no longer kills the
  scan does not therefore go unnoticed.

## What this does not settle

All seven are defects in our code and all seven are fixed. **Which one actually killed that
member's scanner still needs one line from his machine.** **Defect 7 is the leading explanation for
the second affected member**, whose `codex` row has never existed, with defect 6 second
because it cannot account for "never". Neither is confirmed: that needs her
`scanner.log`, and the fix only reaches her once she is on this version. Server-side data
establishes that the scanner has not run, not why.

The diagnostic previously recorded for this fault is also wrong and is corrected
alongside this change: its first step reads `LastTaskResult`, which before defect 3
was fixed could not detect the fault it was meant to find.

## Review round

Adversarial review through the `agy` CLI, against a copy outside the repo. Three of the
five changes were confirmed correct with reasoning, and two findings came back. Both
real.

- **Important, a test that asserts nothing on Windows — correct, and the irony is the
  point.** The unreadable-directory case locked a directory with `fs.chmod(0o000)`, but
  on Windows `chmod` only toggles the read-only attribute and `readdir` still succeeds,
  so the guard against running as root also swallowed Windows and the test quietly
  returned without asserting. A test that silently passes while checking nothing is the
  exact defect this whole release is about. Replaced with a path that is a regular file,
  which fails `readdir` with `ENOTDIR` on every platform, and the `chmod` case now skips
  out loud instead of returning. Red-green verified by restoring the old swallowing
  behaviour with the export kept, so the first attempt's red — a module that failed to
  link — did not count.
- **Minor, a hung scan can outlive the task — correct, and not made worse here.**
  `WScript.Shell.Run` does not put the child in a Job Object, so when Task Scheduler
  enforces the 10-minute limit it kills `wscript.exe` and leaves `node.exe` running.
  True, but before this change the launcher returned immediately, the execution limit
  never applied at all, and a hung node ran unbounded while the task reported success.
  Waiting is what gives the limit any effect. `acquireLock` bounds the damage to missed
  scans. Recorded as `BACKLOG.md` item 16 rather than fixed here, since closing it means
  node imposing its own deadline.

### Round 2

The first round covered five changes; the sixth was added afterwards at Vin's request,
so it went through its own round. One finding.

- **Minor, `undefined` where a reason belongs — correct.** A throw that is not an `Error`
  has no `.message`, so the skip line would have read `skipped /a/one.jsonl: undefined`.
  A log line that appears to explain and does not is the same defect as everything else
  in this release, so it was worth the one line: `err?.message || String(err)`.

The reviewer confirmed the rest with reasoning worth keeping: skipping a file loses
nothing, because offsets are only committed after a successful POST, so the next run
re-reads from the old offset and the server's `UNIQUE (user, tool, session_id,
message_id)` absorbs the replay. The `archived_sessions` re-read was already true before
this change and is absorbed the same way. The `skipped = []` destructuring default keeps
the three adapters that do not report it working unchanged.

### Round 3

The seventh change went through its own round. **No findings.** A clean review is treated
as a reason to check rather than a reason to relax, so the load-bearing claim was
verified independently: that the file offset advances past a skipped line.

It does. `offsetPatch` is written after the line loop at file level, and `runScan`'s
zero-event branch still commits offsets (`base.js`, `if (Object.keys(offsetPatch).length
> 0)`). So even a file that is bad from end to end is stepped over once rather than
retried forever.

The reviewer also confirmed that `currentModel` tracking is unaffected, because it is
updated in the `turn_context` branch and never in the `token_count` branch that can now
`continue`; and that mixing line-level `BADLINE` with file-level `ENOENT` in one
`skipped` array is safe, because the only consumer counts and de-duplicates.

## Non-goals

- **No alert, broadcast, or notification.** Written and then removed on 2026-08-05
  after Vin's correction that notifying an admin is not a cure. The detection logic
  and its tests are not part of this release.
- **No change to `collector_heartbeat`'s shape.** It is `UNIQUE (user_id, tool)`, so
  one person's two machines overwrite each other's rows. Real, but it affects exactly
  one account today and reaches the console and the statistics; it belongs in its own
  release.
- **No macOS or Linux equivalent.** launchd and systemd do not share these
  mechanisms, and the reported failures are all Windows.
