# Home redesign: 總覽 answers the two questions the owner opens it for

## Why

In an interview after the v1.32 console rebuild, Vin said he opens the console for two
things: is the AI keeping the rules, and how are teammates using it. He does not open it to
manage memories or clear a backlog.

The v1.32.2 總覽 did not answer either. 「等你處理」 listed 67 handoffs and 52 lessons he will
never process, and he could not tell what clicking would do. The four tiles (205 場, 95%,
最常做的專案, 8/9 位同事) were read but not understood. He approved a mockup of the layout
below.

## What changes

Top to bottom:

1. One headline sentence for the period, plus one line naming what needs a look
   (compliance down against the period before, teammates idle for two weeks or never
   started, teammates who often miss rules, memory or a computer not working). When nothing
   has arrived at all it says so instead of "all normal".
2. 「AI 守規矩」: the caller's own rate, the previous period's rate, a better / worse / same
   badge, "N 次裡有 M 次 AI 沒照規矩做", the three rules missed most (skip + violate) by
   title, and a footnote with the sessions that reported nothing (this replaces the
   規矩檢查 light).
3. 「同事用得怎樣」 (admin+ only, as /api/usage/team-overview): per person the same rate,
   conversations counted once per session id, and a one-line verdict; problems first.
4. 「要你決定的事（N 件）」: at most five items that moved in the last 7 days, one sentence
   each with a 「去看」 link into the inbox tab. Older items are left off the home page only;
   nothing is deleted or changed, and the footer says how many are left off.
5. A small footer with the memory and computer lights; yellow or red only when something is
   wrong, with the existing fix sentence.

Removed from home: the four tiles and the daily sessions chart (用量與規矩 keeps usage).
The 7 / 14 / 30 day switch stays; comparisons say 前 N 天 for 14 and 30.

## Data

`GET /api/me/overview` keeps its route and auth and returns `lights` (memory, reporting),
`rules`, `team` (null for members) and `decisions`. Every number comes from tables the
console already reads: `activity_logs` (init and iron_rule_compliance), `session_logs`,
`memories` (rule titles, the caller's own code first), the inbox tables and
`collector_heartbeat`. No model is called.

## Not in scope

Drill-down from a rule to the sessions that missed it (Vin: knowing which rule is enough).
Auto-archiving old inbox items; the 7-day cut is display only.
