# v1.26.74 — Spec

## Requirement 1 — 最近活動 reflects the last thing the person did

### Scenario: somebody is in the middle of a long working session

- **GIVEN** a member started a conversation at 00:20 and is still working at 08:20
- **AND** the AI has not yet called `ownmind_log_session`
- **THEN** the column reads a time from within that session, not 00:20

`session_logs` is written once, near the end of a conversation. Read alone it reports when
a session **started** and freezes until it finishes, so the longer somebody works in one
sitting the more wrong it gets.

### Scenario: three sources, three delays

- **THEN** the value is `GREATEST` of `session_logs.created_at`, `activity_logs.ts` and
  `token_events.ts`

`token_events` is the only one of the three that moves mid-session. Its `ts` is the
**message** timestamp, not the upload time, so the scanner's 30-minute schedule delays
when a value becomes visible and never changes what the value says.

### Scenario: a member with nothing in one source

- **GIVEN** a member has never produced a `token_event`
- **THEN** the column still reports from the sources they do have

Postgres `GREATEST` ignores NULL arguments and returns NULL only when every argument is
NULL.

### Scenario: a member with nothing in any source

- **THEN** the value is NULL and the row sorts last

## Requirement 2 — The list and the column agree

### Scenario: sorting

- **THEN** the `ORDER BY` uses the same expression that is displayed

Ordering by `MAX(session_logs.created_at)` while displaying something else would put the
top row in the wrong place, which is a second defect wearing the first one's clothes.

### Scenario: the window

- **GIVEN** a `from`/`to` range on 團隊用量
- **THEN** every one of the three sources is bounded by that same range

An unbounded source would let activity outside the period drag a row's timestamp forward,
and the page would disagree with its own date picker.

## Requirement 3 — Membership is unchanged

### Scenario: a member with token events but no session log in the range

- **THEN** they still do not appear in 團隊用量

What the timestamp means and who the page is about are separate questions. Widening the
`JOIN session_logs` would quietly answer the second one while claiming to fix the first.
Whether this page should list everybody is a real question and belongs in its own change.

## Requirement 4 — 統計儀表板 does not disagree

### Scenario: the same person on both pages

- **GIVEN** 統計儀表板 also shows a `last_active`
- **THEN** it is computed from the same three sources

It was `MAX(activity_logs.ts)` alone, which moves only when the AI calls an ownmind tool —
a long coding session may never call one. Two pages answering one question with two
numbers is its own defect.

Its `last_active` remains lifetime-scoped rather than window-scoped, as it was before this
change: that page's `$1` bounds the counts beside it, and the column has always meant
"when did we last hear from this person at all".
