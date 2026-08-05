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
