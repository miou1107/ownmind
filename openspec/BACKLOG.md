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

### 14. One person's two machines overwrite each other's collector status

`collector_heartbeat` is `UNIQUE (user_id, tool)`, so a member has exactly five slots
however many computers they own, and the UPSERT overwrites `machine`, `scanner_version`
and `os` every time. Two machines belonging to one account continuously erase each other.

Watched happen on production 2026-08-05. At 11:50 Vin's rows read `claude-code` on
`TANK` and the other four on `Vincent.local`. After a manual scan on the Windows box at
12:30, all five read `TANK`, and the Mac's status was gone from the database with no
record it had ever reported.

The consequence is not cosmetic. **A dead collector on one machine is invisible while
another machine of the same person is alive**, because the heartbeat is fresh and the
usage is flowing. 系統設定 also shows only the last writer, so the second machine does not
appear at all.

Blast radius today is one account: nine machine names map one-to-one onto nine users
except for Vin. It grows the moment anyone else runs a laptop and a desktop.

Fixing it means the uniqueness moving to `(user_id, tool, machine)`, which reaches the
console, `admin-clients.js`, and anything that counts installs. Its own release.

Origin: v1.26.65 investigation.

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
