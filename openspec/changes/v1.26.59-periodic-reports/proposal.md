# v1.26.59 — 週報月報 in the console (consolidation Stage 7)

Parent: `openspec/changes/single-console-consolidation/`, Stage 7.

## Why this is the last stage that moves a feature

`periodic-reports` is the only entry left in `shared/legacy-console-manifest.js` still
marked `signpost`. Flipping it to `live` empties the signpost list, and by Requirement 5
that alone stops `src/app.js` serving `/admin` and starts it redirecting — no other edit.
So this change has to be right about the page *and* about what happens the moment the
manifest is empty; the second half is the part with no undo through a config flag.

## What the legacy tab is

`src/public/index.html:371-414` (markup) and `:2737-2777` (`loadReport`). One
`GET /api/session/report?period=week|month&offset=0..3`, three number cards, two
top-ten lists, and a click handler on every list row that opens a modal searching
memories for that row's text (`searchMemory`, `:1491`).

The report is per-user: `GET /api/session/report` filters `WHERE user_id = $1`
(`src/routes/session.js:175`). It has always belonged to every member, but no member
below `admin` can log into the legacy console at all
(`POST /api/admin/login` filters `role IN ('admin','super_admin')`), so the signpost was
pinned at `admin` since v1.26.46 with a comment saying it drops to `user` when the real
page exists. This is that release.

## The count the umbrella task said to fix — and the correction

Stage 7's task list says: "the Suggestion Action count renders empty while the Top
Suggestions list below it has a row. The list proves the data exists, so the count query
is wrong."

Measured in the source: **there is no count query.** `computeReportData`
(`src/utils/report.js:96-103`) returns `period`, `new_memories`,
`friction_issues_created`, `top_frictions`, `top_suggestions`, `generated_at`, and the
route adds a real `friction_issues_created` afterwards. Nothing anywhere emits
`suggestion_actions_created`, so the legacy `data.suggestion_actions_created ?? '—'`
resolved to `undefined` on every request since the card was written and rendered `—`
forever. Not a wrong query: an absent one.

The counterpart data is real. `src/jobs/weeklyReport.js:77-86` inserts a `principle`
memory tagged `['suggestion-action','auto-generated']` for every suggestion seen three or
more times, exactly mirroring the friction issues at `:36-45`. So the fix is the
symmetric count, not a new feature.

## What "no data" means on this page — four states, one label today

The legacy page prints `本期無 friction 資料` whenever the list is empty. That single
sentence covers four different situations, three of which are not "you had no frictions":

1. No session was logged in the period at all — nothing is known about it.
2. Sessions were logged but none carried a `details` payload — the tool reported, the
   reflection fields were empty.
3. Sessions were logged and analysed, and genuinely contained no friction text — a real
   zero, and the only case the current sentence describes correctly.
4. The period is older than `SESSION_RETENTION_DAYS` (90, `src/constants.js:5`), so
   `compressOldSessions` has replaced those rows with one monthly summary carrying no
   `details` and **deleted the originals** (`src/routes/session.js:136-141`). The report
   query filters `compressed = false`, so the evidence is not merely hidden, it is gone.
   Reachable from the UI: 月報 + 三期前 is 60 to 120 days back.

Requirement 7 is the umbrella rule that "no data" and "zero" are different values carried
by the data layer. The endpoint currently cannot express the difference, so it gains two
counts (`sessions_total`, `sessions_analyzed`) and the window it used (`period_start`,
`period_end`, `detail_retention_cutoff`). Every one is a number the route already had or
can get in the same round trip.

## Deliberately not changed: what the two "created" counts mean

`friction_issues_created` counts memories **created inside the window**. The job runs
Monday 00:00 for the *previous* week (`runWeeklyReport` → `computePeriodRange('week', 1)`),
so the issues distilled from last week's frictions are created this Monday and land in
*this* week's count. The number is a true count of creations in the period; it is not
"how many issues your frictions this period produced".

Changing the query to attribute issues back to the period they describe would need a
period stamp the memories do not carry. So the query stays and the page says which one it
is, in one line under the two cards. Requirement 3 keeps endpoint behaviour unchanged
where it can; inventing an attribution we cannot compute would be the worse trade.

## The memory-search modal

Stage 5 recorded that the memory-search modal is not on the stats page — `data-search-text`
appears only inside `loadReport` — and left it as "Stage 7's decision". Decision: port it.
Requirement 3 is that consolidation loses no feature, it is one `GET /api/memory/search?q=`
against a route the console already depends on, and without it the two lists become dead
text where they are clickable today.

## Non-goals

- No change to the weekly/monthly cron jobs. They already write both counts into their
  snapshots (`weeklyReport.js:194-195,285-286`); only the on-the-fly API was missing one.
- No new attribution model for the two created-counts, per the section above.
- No redesign of `computePeriodRange`. Its week/month boundary maths is covered by
  `tests/report.test.js` and is not what this stage is about.
- The legacy `loadReport` is **not** updated for the new response shape, unlike Stage 6's
  coverage panel. Stage 6 had to, because `/admin/` was still served. This change retires
  it in the same commit, so the code is unreachable before the shape changes. Stage 8
  deletes the file.

## Risk

The manifest flip is the release's real payload, and its blast radius is "the old console
stops answering". The guard is that both directions are already tested
(`tests/legacy-console-manifest.test.js`, `describe('/admin either/or')`) against a
synthetic manifest, so retirement is exercised without waiting for this release. What was
*not* covered is the live end-to-end case, because every e2e signpost spec is written to
skip when nothing is signposted — which is now every run. This change adds the mirror
spec: when the manifest is empty, `/admin/` must redirect rather than serve.
