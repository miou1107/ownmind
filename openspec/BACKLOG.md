# OpenSpec Backlog

Work that a change folder identified, deliberately did **not** do, and that is still
open. It lives here rather than inside the change folders because
`openspec/changes/archive/` is frozen the moment a proposal moves in (CONVENTIONS.md
§4), and a frozen snapshot is the wrong place to track live work.

Entries are **mirrored, not moved**. The originals stay unticked in the archived
tasks.md files, because those files record what actually happened at the time and
editing them would falsify the record. This file is the live one: when an item ships,
delete it here and leave the archive alone.

Each entry names where it came from. Removing an entry means it shipped or was
decided against; say which in the commit message.

---

## Needs a release of its own

### 1. Resetting a password does not cut off the person's access

What remains of the original entry after v1.26.63, which closed the half where a
temporary password was exchanged for a permanent `api_key` at login.

An admin resetting someone's password (`src/routes/admin-password-reset.js:88`) sets
`must_change_password` back to `TRUE` and leaves the `api_key` untouched. That person's
open browser session and their installed MCP keep working exactly as before, so a reset
performed *because* a password leaked revokes nothing. `RequireFreshPassword` still nudges
them in the console, and it is still only a localStorage flag they can delete.

Closing it means rotating the `api_key` on a password change. That invalidates the
person's installed MCP configuration and requires them to re-run the installer, probably
without knowing why it stopped working, so it needs a story for how they find out. Vin
deferred the decision on 2026-08-05 rather than rejecting it.

Origin: `archive/single-console-consolidation/tasks.md`, Stage 0, narrowed by v1.26.63.

### 2. Period bounds lose a microsecond

`computePeriodRange` ends a period at `…59.999` and every consumer compares
`created_at <= end`, while postgres keeps microseconds. A row at `…59.9995` falls out
of both that period and the next. Not fixed inside a presentation change because the
function is shared with the weekly and monthly cron jobs, which **write** data from
those bounds.

Origin: `archive/single-console-consolidation/tasks.md`, Stage 7.

### 3. `unknown_model` checks against a table nothing can populate

`src/routes/usage/events.js` decides whether a model is "known" by looking it up in
`model_pricing`, and v1.26.60 deleted the CRUD that maintained that table. The signal
was always "not in the price list", which is why it already fires for nearly every
model; it now cannot be anything else. Untouched because it sits in the ingestion
path, the most load-bearing code in the product.

Origin: `archive/single-console-consolidation/tasks.md`, Stage 8.

### 4. Nothing tells anyone a collector went quiet

The 系統設定 panel names who is missing, but only to whoever opens the page. Traced on
production 2026-08-04: one member's scanner stopped uploading on 07-15 and nobody
noticed for twenty days, because his MCP kept heartbeating daily and the old metric
counted that as covered. The two heartbeats have different writers, which is the whole
diagnostic: `mcp/index.js` sends `events: []` with an `os` field for one tool, while
`hooks/ownmind-usage-scanner.js` sends five tools within the same second and no `os`.
**One row moving alone means the scheduled scanner is dead while the MCP is fine.** A
"reporting nothing for N days" broadcast would close the loop; OwnMind memory 740 has the
full trace and the per-member state.

Origin: `archive/single-console-consolidation/tasks.md`, Stage 6.

### 5. The api client has no request timeout

A hung `/api/me/profile` leaves an admin route blank with nothing logged. It is a
shared client affecting every request, so the change reaches wider than any one page.

Origin: `archive/single-console-consolidation/tasks.md`, Stage 0.

---

## Needs Vin's decision

### 7. Two pages tell two stories about the same three members

Members with zero events render as real zeros on 整體分析, which is correct: they are
instrumented, so an in-period zero is genuine. But the usage page's own
`team_blindspot` finding calls the same three "OwnMind 對其工作完全不可觀測". The
honest resolution is probably a third state (instrumented, but no signal at all in the
period), which neither Requirement 7 nor the review anticipated.

Origin: `archive/single-console-consolidation/tasks.md`, Stage 1b.

### 8. `/portal/narrative` is open to the `user` role

Faithful to `/me/` today and to Requirement 3's "same endpoints, unchanged", but it
means a member sees team-wide activity ranking and every colleague's per-rule
compliance counts, while the same class of data in the 團隊 section is admin-only. Not
narrowed unilaterally, because doing so removes access members have today. Requirement 3
did not anticipate the tension with the new section model.

Origin: `archive/single-console-consolidation/tasks.md`, Stage 1b.

### 9. 廣播管理 create/revoke is untested, deliberately

The page renders its existing broadcasts cleanly, but creating one puts a message in
front of every member's AI session. Outward-facing, so it is Vin's call rather than
something to run as a test.

Still true 2026-08-05, and revoke is now the harder half: the only rows on the page are
live broadcasts, including the upgrade notice sent to Eric today, so pressing 撤銷 to
prove the button works would cancel a real message. That half is this session's
observation, not the original entry's.

Origin: `archive/single-console-consolidation/tasks.md`, Stage 3.

### 13. The footer's 版本更新紀錄 button always says there is nothing

Raised by Vin 2026-08-05 from production: clicking it opens a dialog reading
「目前尚無版本紀錄」, and it always will.

Not broken. Never connected. `client/src/App.jsx:97` passes `changelog: []` as a literal,
and the comment above it says so on purpose: 「changelog 刻意留空⋯⋯真正的更新紀錄來源是
獨立的一件事」. The button, the glass dialog and the timeline rendering are all finished
and correct; there is no data behind them. Every visitor who clicks it learns that this
product has no release history, which is the opposite of true.

Three ways out, and the choice is the point:

- **Serve it.** `CHANGELOG.md` is the source of truth but it is roughly seven thousand
  lines and written for developers; it cannot be shipped to the browser whole. An endpoint
  returning the last N parsed entries would work, and would have to answer what to do
  about the fact that the file is Chinese only while the console ships in three languages.
- **Curate it.** A small hand-written data file of user-facing releases, which is what
  idaytour does. Cheap, but it is a second thing to remember to update at release time,
  and this project already has three version numbers to keep in step.
- **Remove the button.** A control that has never once shown content is worse than no
  control.

Removing it is a few minutes; either of the others is a release. Doing nothing is the
option that keeps lying to whoever clicks.

### 14. One person's two machines overwrite each other's collector status — FIXED in v1.26.73

`collector_heartbeat` was `UNIQUE (user_id, tool)`, so a member had exactly five slots
however many computers they owned, and the UPSERT overwrote `machine`, `scanner_version`
and `os` every time.

Watched happen on production 2026-08-05. At 11:50 Vin's rows read `claude-code` on
`TANK` and the other four on `Vincent.local`. After a manual scan on the Windows box at
12:30, all five read `TANK`, and the Mac's status was gone from the database with no
record it had ever reported.

**Fixed in v1.26.73:** the key is `(user_id, tool, machine)`, `machine` is `NOT NULL
DEFAULT 'unknown'` so a NULL cannot silently create unbounded rows, and the `DO UPDATE`
no longer assigns `machine` — that one assignment was the whole mechanism.

**Still open, and it is a design question rather than a defect:** the 系統設定 panel now
lists a tool once per machine. The machine name is in the data so the entries are
tellable apart, but how two computers should be presented wants a mockup before any
rendering changes.

Origin: v1.26.65 investigation. Closed by v1.26.73, 2026-08-06.

### 15. `renderBroadcasts` tells everyone to say "snooze upgrade"

`mcp/index.js` renders the snooze hint as `Say "snooze upgrade" to defer` for **any**
broadcast with `allow_snooze`, not just upgrade reminders. An admin creating a
snoozeable announcement in 廣播管理 today produces a message instructing the reader to
snooze an upgrade that is not being offered.

One line, but it is in the injection path that every member sees, so it wants its own
verification rather than a drive-by edit.

Origin: v1.26.65 investigation, found while checking what a new auto-broadcast would
render as.

### 16. A hung scan can outlive the task that started it

`run-hidden.vbs` launches node through `WScript.Shell.Run`, which does not place the
child in a Windows Job Object. When Task Scheduler enforces the task's 10-minute
`ExecutionTimeLimit` it kills `wscript.exe`; the `node.exe` underneath survives and
keeps running.

`acquireLock` stops a survivor from being scanned over: the lock holds the live PID, so
later runs skip until the six-hour mtime rule takes over. So the cost is up to six hours
of missed scans, not corruption.

Not introduced by v1.26.65 and not made worse by it. Before that release the launcher
returned immediately, so the execution limit never applied and a hung node ran unbounded
with the task reporting success. Waiting is what makes the limit meaningful at all.

Closing it properly means node imposing its own deadline, since VBScript cannot create a
Job Object. Raised by the v1.26.65 adversarial review.

Origin: v1.26.65 review.

### 17. One member's `codex` collector has never once checked in

Amiee Kuo (user 9) has **no `codex` row in `collector_heartbeat` at all**, on a server
where the other eight members do, including members who almost certainly never run
Codex. Her four sibling adapters on the same machine have rows. Her usage stops at
2026-05-05.

The heartbeat is built *after* the file loop in `readSince`, so anything that throws
inside the loop costs that tool its check-in as well as its data. A missing row is
therefore a permanent, server-visible marker of a permanently-throwing adapter, and
nothing was reading it.

**Ruled out on 2026-08-05, so the next session does not repeat it:**

- *Not the Codex path.* Verified end to end on Vin's Mac: a live Codex session produced
  two events that reached the server in ten seconds, local and server newest timestamps
  matching to the second, and both counts moving by exactly +2.
- *Not the throw path firing on ordinary data.* A probe over that machine's whole Codex
  history — 83 files, 10,084 `token_count` lines — threw zero times and found zero
  unreadable files.
- *Not a different account.* Nine machine names map one-to-one onto nine users with no
  overlap, so her scanner is not succeeding under someone else's key.

**What v1.26.65 changed.** It closed two mechanisms that produce exactly this shape:
a file that cannot be opened (defect 6) and a line that cannot be turned into an event
(defect 7). Neither is confirmed as *her* cause, and **the fix only reaches her once she
upgrades** — her tools report 1.26.26, except claude-code at 1.26.57.

**Which of the two is more likely.** "Never" is not "sometimes". Defect 6's trigger is
the archival race, which is intermittent, so across months at least one run should have
got a check-in through. Defect 7 is deterministic: the same bad line fails every run.
That said, the probe above shows defect 7 does not fire on normal current-version Codex
data, so if it is her cause the data itself is unusual — an older format, or a corrupted
file.

**The one command that settles it.** Read-only, sends nothing, uses her own installed
adapter against her own files:

```powershell
node -e "const os=require('os'),path=require('path'),url=require('url');const p=path.join(os.homedir(),'.ownmind','shared','scanners','codex.js');import(url.pathToFileURL(p).href).then(async m=>{const a=m.createCodexAdapter({});try{const r=await a.readSince({});console.log('OK events='+r.events.length+' heartbeat='+!!r.heartbeat)}catch(e){console.log('THROWS: '+((e&&e.message)||e))}})"
```

`THROWS:` followed by `canonicalize: invalid …` is defect 7. `THROWS:` followed by an
`ENOENT`/`EACCES` path is defect 6. `OK` means both hypotheses are wrong and the search
starts again — the next place to look would be `OWNMIND_SKIP_TOOLS` in her environment,
then whether her scanner reaches the codex adapter at all.

Vin deferred the investigation on 2026-08-05; it needs access to her machine.

Origin: v1.26.65 investigation.

---

### 18. Antigravity: usage collection fixed in v1.26.68, MCP wiring still missing

**Most of this item is done, and one of its measurements was wrong.** Kept in full
because the wrong measurement is the useful part.

v1.26.68 gave the collector a second date source: the per-conversation files under
`~/.gemini/<surface>/conversations/`. All three surfaces write there, so manager and CLI
days are now recorded. What follows is the original entry, corrected inline.

**The correction.** The entry below concluded that using the manager wrote no session or
conversation data locally. That was measured under
`~/Library/Application Support/Antigravity`, where the Electron shell lives. The
conversation store is under `~/.gemini/antigravity/conversations/`, and the 22:35
conversation was there all along as `df8d3160-….db`, mtime 22:37. "I searched where this
kind of application usually puts things and found nothing" got recorded as "the
application writes nothing".

There are also three surfaces, not two: the manager, the editor, and the CLI (`agy`),
whose store is `~/.gemini/antigravity-cli/` and which is the busiest of the three
(1489 conversation files).

**What is still open.**

`install.sh` writes no MCP config for Antigravity, only a rules file, so no heartbeat
and no `user_tool_last_seen` will ever fire for it. Usage days now arrive through the
scanner, so this is no longer a blind spot, but the tool still cannot report itself.

The config path is confirmed three independent ways:

- Official docs (`antigravity.google/docs/mcp`): `~/.gemini/config/mcp_config.json`
  globally, `.agents/mcp_config.json` per workspace
- The manager binary (`Antigravity.app/Contents/Resources/bin/language_server`) contains
  the literal `/.gemini/config/mcp_config.json`; the editor 2.1.1 still contains the
  pre-migration `.codeium/antigravity/mcp_config.json`
- On the measured machine `~/.gemini/config/mcp_config.json` exists and is **0 bytes**,
  next to a `.migrated` marker dated 2026-05-20, the same day the storage directory
  rename in v1.26.66 happened

So the whole product migrated on 2026-05-20: app support directory, config directory and
conversation store together.

Schema for a stdio server is `{ mcpServers: { name: { command, args, env } } }`, so the
existing `MCP_ENTRY` shape fits. It needs `OWNMIND_TOOL: 'antigravity'` or the heartbeat
lands on the `claude-code` row (v1.26.67).

Note `~/.codeium/windsurf/mcp_config.json` on this machine lists `ownmind` with no
`OWNMIND_TOOL`, so if Windsurf ever launches it, it reports as claude-code. That file is
hand-written; `install.sh` has never written a Windsurf MCP config.

**Also still open:** historical backfill. The adapter reports only the freshest day, so
the ten days missing between 2026-05-18 and 2026-08-05 stay missing.

---

### 18a. Original entry, kept for the measurement error (superseded)

Antigravity ships as an agent manager (`Antigravity.app`, `com.google.antigravity`) and
a separate editor (`Antigravity IDE.app`, `com.google.antigravity-ide`, VSCode OSS
1.107.0). The manager's window has an "Open IDE" button; they are two components of one
product, not two versions of it.

Only the editor leaves a trace OwnMind can read. v1.26.66 fixed the collector to find
the editor's `state.vscdb`, so editor usage is now recorded. **Work done in the manager
is invisible in every channel.**

**Measured on Vin's Mac, 2026-08-05.** He ran a real conversation in the manager at
22:35 while both applications were running. Afterwards:

- `Antigravity/User/globalStorage/state.vscdb` — untouched. `currentSessionDate` still
  2026-05-18, file mtime still 2026-05-20. Launching and using the manager does not
  write it.
- Files written under the manager's directory in the following ten minutes — Chromium
  and Electron infrastructure only (`Code Cache`, `GPUCache`, `Session Storage`, `DIPS`,
  `Network Persistent State`) plus `app_storage.json`, which holds seven UI preference
  keys and no dates. No session or conversation data appeared locally.
  **WRONG — the conclusion, not the observation.** Everything listed here is accurate for
  `~/Library/Application Support/Antigravity`. The conversation went to
  `~/.gemini/antigravity/conversations/df8d3160-….db` at 22:37, a tree that was never
  looked at. Absence of evidence in one directory was written down as evidence of
  absence.
- `user_tool_last_seen` on production — no MCP call at 22:35. The only row for that user
  is `claude-code` at 13:07 UTC.

The manager still recites the iron rules, because `install.sh` writes
`~/.antigravity/rules/ownmind.md` (line 352). Its own reply said it was reading "系統環境
與設定檔". So memory delivery works and usage collection does not.

**No OwnMind MCP process runs under either Antigravity application.** Checked by parent
process: every `~/.ownmind/mcp/index.js` process on that machine is a child of
`Claude.app`. `~/.codeium/windsurf/mcp_config.json` does list `ownmind`, but nothing is
launching it. The installer writes rules files for Antigravity and Windsurf and never an
MCP config (`install.sh` lines 780-782, 713-716).

**Why this is worth doing.** A heavy manager user looks completely idle. It is the same
shape as the bug that produced v1.26.66: the person is working, the collector sees
nothing, and no layer reports an error.

**What is unknown.** Where the manager stores its conversation history. Nothing local
was written during the ten-minute window, which is consistent with cloud storage but is
not proof; it may also flush on quit. Determining this means reading its LevelDB store,
which holds conversation content, so it was not done without Vin present.
**ANSWERED, and the reasoning above is the lesson.** It is local, in `~/.gemini`, and no
LevelDB read was needed: the file names and mtimes were enough. The plan had committed
to opening a store full of conversation content to answer a question about *timestamps*,
because it had already accepted a wrong premise about where to look.

**Sequence if picked up:** steps 1 and 2 are done (v1.26.68). Step 3, the MCP config, is
still open and its path is now known; see item 18 above.

Origin: v1.26.66 / v1.26.67 investigation, 2026-08-05. Superseded by v1.26.68 the same
night.

---

### 19. The installer's two Antigravity blocks write to two different paths, so the upgrade rule never arrives

`install.sh` touches Antigravity twice and they disagree:

- Line 352 appends the upgrade snippet to `~/.antigravity/rules/ownmind.md`, guarded by
  `[ -d "$HOME/.antigravity/rules" ]`
- Lines 780-801 write the memory rules to `~/.antigravity/rules.md`, a file, and never
  create a `rules/` directory

Nothing else creates `~/.antigravity/rules/`, so the guard never passes and Antigravity
is the one tool that silently never receives the upgrade rule. `SKIPPED_TOOLS` is
incremented and the installer prints a normal-looking count, so it reads as "not
installed" rather than "misconfigured".

**Measured 2026-08-05.** `~/.antigravity/` holds `antigravity/`, `argv.json`,
`config.md`, `extensions/`, `rules.md`. There is no `rules/`. `rules.md` matches the
heredoc at lines 787-798 exactly, so that half works, and the manager does recite the
iron rules.

Not a one-line fix. Pointing line 352 at `rules.md` would put the upgrade snippet in the
same file section 11 writes, and section 11's guard is `grep -q 'OwnMind' rules.md` — if
the snippet lands first, section 11 decides its own block is already there and skips the
memory rules. The two blocks have to be reconciled together, with a test.

Also worth settling in the same change: `~/.antigravity/rules.md` versus
`~/.antigravity/rules/` is an assumption nobody has checked against Antigravity's own
documentation. `rules.md` demonstrably works; whether `rules/*.md` is also read, or is
the newer convention, is unknown.

Origin: v1.26.68 investigation, 2026-08-05.

---

### 20. Tier 2 could only read `state.vscdb` while the editor was running — FIXED in v1.26.70

Found within a minute of v1.26.69 landing, by reading its own new output:

```
[scanner] cursor sent=0 ... sessions=0 reason=unreadable
```

**The first version of this entry drew the wrong conclusion, and the correction is the
useful part.** It said Cursor usage had been "invisible since at least 2026-06-02",
because the telemetry read `2026-06-02` and the file's mtime was the same day. Both were
true and neither meant that. Vin opened Cursor an hour later, the file's mtime became
current, `currentSessionDate` became current, and the collector reported
`cursor sessions=1 reason=ok`. 2026-06-02 was simply the last time he had used Cursor.

That is iron-rule 770 exactly: a zero was read as a finding without a positive control.
The positive control arrived when the user went and used the tool.

**The real defect, isolated with a controlled test on 2026-08-06.** Copy the database to
an empty directory so nothing sits beside it:

```
$ sqlite3 -json -readonly "<copy>" "SELECT key FROM ItemTable LIMIT 1;"
Error: in prepare, unable to open database file (14)

$ sqlite3 -json "file:<copy>?immutable=1" "SELECT key FROM ItemTable LIMIT 1;"
[{"key":"HostColorSchemeData"}]
```

Same bytes, two outcomes. Against the *live* file the same `-readonly` command succeeds
while Cursor is running, and a `state.vscdb-shm` sidecar is present. With Cursor closed
there is no sidecar and the open fails.

So Tier 2 collection currently depends on the editor being open at the moment the
scheduled scan fires. On a 30-minute schedule that is partly luck; on Windows, where the
task repeats every 120 minutes, it is mostly luck. The days it misses are invisible
rather than wrong, which is why nothing ever flagged it.

Antigravity is insulated by accident: v1.26.68 gave it the `~/.gemini` conversation
store, so it has a second source when the database will not open. Cursor has no fallback.

**Fixed in v1.26.70**, and the plan written here was wrong twice on the way:

- "copy the file and read the copy" fails identically. What `-readonly` wants is the
  `-shm` sidecar and a bare copy has none either.
- `immutable=1` on the copy fixes that but drops the WAL, and these databases are in WAL
  mode with a live `-wal` beside them. The uncheckpointed part is exactly the newest
  activity.

What shipped: copy the database **with its journal sidecars**, open the copy with no
flags so SQLite can replay the WAL on a snapshot it owns, delete the temporary directory
afterwards. The live file is only ever opened `-readonly`.

`shared/scanners/opencode.js` had its own copy of the same pattern and the same
exposure. **Closed by v1.26.71**, which moved the fallback into
`shared/scanners/sqlite-cli.js` so both callers share one implementation and a third
copy cannot appear.

**Still open:** nothing has run the fallback on Windows. The logic is platform-neutral
and every path is built with `path.join`, but no Windows machine has executed it. The
cheapest proof is one manual scan on TANK with an editor closed, checking the collector
reports `reason=ok` rather than `unreadable`.

Since v1.26.78 this is no longer the only Windows gap; it is one item inside the larger
one recorded as **backlog 24**. Verify them together.

The macOS half is now closed. Proven on 2026-08-06 with the three preconditions checked
before the scan rather than after: OpenCode shut so `-readonly` genuinely failed, no
sidecar present so the probe had not created the condition, and three unsent messages so
a result of zero would have meant something. Two events landed and no sidecar was left
behind.

Origin: v1.26.69, 2026-08-06. Closed by v1.26.70 the same night; its follow-up closed by
v1.26.71.

---

### 21. OpenCode's cursor can step over a message that shares a millisecond with another

Raised by the v1.26.71 adversarial review, verified as a mechanism and measured as
currently unreachable.

`shared/scanners/opencode.js` resumes with
`WHERE time_created > H OR (time_created = H AND id > 'HID')`. Two messages with the same
`time_created`, committed separately, whose ids sort opposite to their commit order: a
scan that sees the later one first advances the cursor past it, and the earlier one is
then excluded by `id > 'HID'` on every subsequent scan. Not a duplicate the server's
UNIQUE can absorb — a row that is never sent.

**Why it is not firing.** Zero same-millisecond pairs across 1205 messages on the
measured machine, which is what you would expect of assistant messages: they are LLM
replies, seconds apart. **But the id is `msg_` plus a time-derived prefix plus a random
suffix, so within a single millisecond the suffix decides the order and it really is
arbitrary.** The mechanism is sound; only the trigger is missing.

Not introduced by v1.26.71. A scan reading the live database between two same-millisecond
commits does the same thing and always could.

Closing it means the resume condition comparing `(time_created, id)` as a tuple against
something monotonic, or resuming inclusively and letting the server's UNIQUE dedupe. Both
change Tier 1 ingestion, which is the most load-bearing path in the product, so it is its
own release with its own verification.

Origin: v1.26.71 review, 2026-08-06.

---

### 22. Two computers with the same hostname are one machine to the server

Raised by the v1.26.73 review. `machine` is a hostname, so two computers both named
`MacBook-Pro` under one account are indistinguishable: each reads the other's heartbeat as
its own, and the v1.26.72 self-check reports `confirmed` on a machine that is not
reaching the server.

Not introduced by v1.26.73 — before it, *all* of a person's computers shared one row, so
this is strictly narrower than what was there. But it is the remaining hole in the same
question.

`shared/device-fingerprint.js` already generates a stable per-device id and is used
elsewhere. Making it the identity means a schema column, a client change, and a story for
rows written before it existed, so it is its own release.

Origin: v1.26.73 review, 2026-08-06.

### 23. `POST /api/activity/batch` cannot be driven from a test

The handler imports `query` from `src/utils/db.js` at module level, so no test can make one
event fail inside the real loop. `createEventsRouter`, `createTeamOverviewRouter` and
`loadClients` all take an injected `query`; this route predates that pattern.

The consequence showed up in v1.26.78: a defect that rejected **every** batch containing an
auto-compliance event survived for the life of the table, and the fix for it (per-event
isolation) can only be asserted by reading the source rather than by driving the handler.
`tests/activity-batch-dedup.test.js` works around it by re-implementing the loop, which
tests a copy of the code rather than the code.

Closing it means converting the module-level router into `createActivityRouter(deps)` and
updating its mount point. Mechanical, but the file carries several other routes and is on
the ingestion path, so it wants its own release rather than riding along with a fix.

Origin: v1.26.78, 2026-08-06.

### 24. Eleven versions have shipped without ever running on Windows

**Blocked, not deferred.** Vin has no Windows machine available as of 2026-08-06; this
waits for one rather than for a decision.

Every change from v1.26.68 to v1.26.78 has been verified on one Mac and nowhere else. The
heartbeat table says so plainly:

```
Vincent Kao       Vincent.local   1.26.78    ← every verification happened here
Vin-windows-test  TANK            1.26.67    ← stopped before any of it
```

TANK is also under a **different account**, which is why it cannot be checked in passing.

What is unverified, worst first:

- **v1.26.65** rewrote the Windows scheduled task registration and the VBS wrapper's exit
  code, and the defect it fixed was "the Windows scanner can die silently and report itself
  healthy". The fix for silent Windows failure has never run on Windows.
- **v1.26.70 / v1.26.71** — the sqlite copy fallback. Platform-neutral logic, `path.join`
  throughout, but never executed there. Was the "still open" half of item 20.
- **v1.26.73** — machine identity. `os.hostname()` behaves differently enough on Windows to
  be worth seeing rather than assuming.
- **v1.26.72** — the upgrade self-check, whose whole job is to report on the machine it
  runs on.
- **v1.26.76 / v1.26.77 / v1.26.78** are server-side and already proven against production,
  so they do not need a Windows machine.

Cheapest proof, one command on TANK once a machine exists:

```
bash ~/.ownmind/scripts/bootstrap.sh
```

Nine checks pass and the ninth reads "the server has this machine's data for 5 tool(s)" →
the whole chain works there. Then one scan with the editors closed, checking the collector
reports `reason=ok` rather than `unreadable`, closes item 20's remaining half too.

Origin: v1.26.78, 2026-08-06. Vin: 「這先列為代辦，我現在沒 win 電腦」.

### 25. Four of nine users have never once produced a real session log

The team usage page shows `尚無資料` under **最常做的專案** and **鐵律遵守率** for Michelle,
Phoebe, 采瑤 and Vin-windows-test. Those two columns read `details.project` and
`details.rules_triggered` / `rules_complied`, which only `ownmind_log_session` writes.
Nobody's collector is at fault: their usage numbers are fine.

Measured on production, `session_logs.details` keys over the last 7 days:

| user | real log_session rows | `_recovery` placeholder rows |
|---|---|---|
| Vincent Kao | 19 | 46 |
| Eric | 15 | 0 |
| Adam | 4 | 0 |
| Michelle | **0** | 14 |
| Phoebe | **0** | 33 |
| 采瑤 | **0** | 128 |
| Vin-windows-test | **0** | 2 |

采瑤 is the sharpest case: 128 sessions in a week, not one of them logged. Every row she
has is a placeholder written by the fallback in `mcp/index.js:1801` / `:1846`
(`_recovery: 'process_exit'`) or `src/routes/memory.js:1771`
(`_recovery: 'from_activity_logs'`), and a placeholder carries no project and no rule
counts by construction.

**Do not fix this by rewording the empty cell.** Vin, 2026-08-06: 「不是改文案寫清楚，而是
要抓到根本原因並修復才對」. The deliverable is those cells holding values, not a better
label for their being blank. See IR-130.

Unknown and to be measured before designing anything:

- Is `ownmind_log_session` never called, or called and rejected? `activity_logs` has a
  `session_log` event; compare its count per user against the real-row count above.
- Does the skill text actually instruct the AI to call it at end of session, and do these
  four have the current skill on disk? Michelle is on 1.26.59, 采瑤 on 1.26.37.
- Vincent has both shapes, so on this machine it fires sometimes. What distinguishes the
  19 that logged from the 46 that fell back?
- If the answer is "the AI has to remember to call it", that is the root cause, and the
  fix is a mechanism rather than a stronger instruction (IR-042: 提醒無效，邏輯才有效).

Origin: 2026-08-06, while explaining the blank columns on the team usage page.

### 26. The Node SessionStart hook does eight fewer things than the bash one

v1.26.80 routes Windows to `hooks/ownmind-session-start.js` because the bash command had
never once fired there. That fixes the thing that matters most — memories and iron rules
now load — but the Node hook is 143 lines against the shell script's 226, and the
difference is not comments:

| bash hook does | Node hook |
|---|---|
| flush pending banners from the last session | missing |
| flush the reply-lint compliance spool | missing |
| daily update check | missing |
| drain the self-check upload spool | missing |
| conditional sync via `sync_token` (skips ~95% of downloads) | missing |
| **fetch and show broadcasts** | **missing** |
| render through `lib/session-start-output.js` | builds its own lines |
| **sync memory files into the project dir** | **missing** |

Two of those are user-visible on Windows: **broadcasts never appear**, and **memory files
are never written into the project directory**. The update check is not lost — `mcp/index.js`
runs its own.

The shell script is mostly a thin orchestrator over `hooks/lib/*.js`, so parity is largely
a matter of calling the same modules rather than reimplementing anything. It was not done
in v1.26.80 because that release was already unverifiable on Windows and widening it would
have made the unverifiable part larger.

Do not close this by declaring the Node hook "good enough". The measure is a Windows
machine showing a broadcast.

Origin: v1.26.80, 2026-08-06, found by adversarial review of that change. Depends on
item 24 for verification.

---

## Smaller cleanups

### 10. Three sibling pages hardcode `toLocaleDateString('zh-TW')`

`BroadcastPage.jsx`, `WorkLogPage.jsx` and the team page. The Stage 5 page derives it
from the active locale like `ProfilePage` does; unifying the other three is
cross-cutting.

Origin: `archive/single-console-consolidation/tasks.md`, Stage 5.

### 11. `tests/console-table-overflow.test.js` does not reach the rule table

Its `border-slate-200…rounded-xl` filter skips the `-mx-4 overflow-x-auto` wrapper, and
the real card class is a template literal in `charts.jsx` that the `<div className="`
scan cannot see. The code complies today; the guard just does not cover it. The helper
is documented as a floor, not a proof.

Origin: `archive/single-console-consolidation/tasks.md`, Stage 5.

### 12. The `kpi.*` locale keys are dead

No component reads any of them; they are leftovers from the v1.20 prototype.
`kpi.api_cost` went with the cost feature in v1.26.60, the rest were left rather than
widening that change into a locale audit.

Origin: `archive/single-console-consolidation/tasks.md`, Stage 8.
