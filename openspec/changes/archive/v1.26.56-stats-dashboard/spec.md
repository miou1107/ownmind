# v1.26.56 — 統計儀表板 spec

Eight requirements. Every scenario below is exercised by a test that runs the code,
not by a regex over its source.

---

## Requirement 1 — One control bar drives two views

### Scenario: no user selected shows the cross-user overview

- **GIVEN** the page has loaded
- **WHEN** the user select is at its empty value
- **THEN** the request is `GET /api/activity/stats/all?days=<range>`
- **AND** the single-user blocks are not rendered

### Scenario: selecting a user shows that user's detail

- **GIVEN** the user select holds a user id
- **THEN** the requests are `GET /api/activity/stats?user_id=<id>&days=<range>` and
  `GET /api/activity/stats/rules?user_id=<id>&days=<range>`
- **AND** the overview table is not rendered

### Scenario: the range is one of three values and defaults to 30

- **GIVEN** a fresh load
- **THEN** the range is 30
- **AND** the only selectable ranges are 7, 30 and 90, matching the legacy select

### Scenario: changing either control refetches

- **WHEN** the user or the range changes
- **THEN** the view for the new pair is fetched

---

## Requirement 2 — A rate that was never measured is not a zero

This is Requirement 7 of the umbrella spec applied to every rate on the page. It is
also a defect fix: the legacy 各規則落地率 and 各工具落地率 blocks band an unmeasured
rate through `t > 0 ? … : 0` and paint it solid red.

### Scenario: a null compliance rate renders as unmeasured

- **GIVEN** a user whose period contains no `iron_rule_compliance` events, so the
  server returns `compliance.rate === null`
- **WHEN** the 鐵律合規率 card renders
- **THEN** it reads as "no data", not `0%`
- **AND** it carries no red / amber / green band

### Scenario: a rule with no events in the period is banded as unmeasured

- **GIVEN** a row of `compliance.by_rule` whose comply + skip + violate is 0
- **THEN** its band is the unmeasured band
- **AND** its bar is not drawn at 0% in the failure colour

### Scenario: a genuine zero rate still reads as zero

- **GIVEN** a rule with 0 comply and 5 violate, so the rate is a real `0`
- **THEN** it renders `0%` in the failure colour
- **AND** it is distinguishable from the unmeasured case above

### Scenario: the bands are the legacy thresholds

- **GIVEN** rates of 90, 89, 70 and 69
- **THEN** they band as high, mid, mid and low respectively

---

## Requirement 3 — 從未被觸發的規則 is a separate statement

### Scenario: untriggered rules are listed, not averaged in

- **GIVEN** `summary.rules_never_tested` is non-empty
- **THEN** those rule titles appear as their own statement
- **AND** they do not lower any displayed compliance rate

### Scenario: nothing is said when every rule has data

- **GIVEN** `summary.rules_never_tested` is empty
- **THEN** no untriggered-rules statement is rendered

---

## Requirement 4 — The overview table carries the eight legacy columns

### Scenario: the columns match the legacy table

- **THEN** the columns are 狀態, 用戶, 記憶, Session, 使用工具, 使用模型, 落地率,
  最後活躍

### Scenario: activity is a seven-day window

- **GIVEN** a user whose `last_active` is 6 days ago
- **THEN** the status dot is active
- **GIVEN** a user whose `last_active` is 8 days ago
- **THEN** the status dot is inactive

### Scenario: a user who has never been active says so

- **GIVEN** `last_active === null`
- **THEN** the cell reads "never", not a date and not a blank

### Scenario: tool and model pills are ordered by count

- **GIVEN** `tools` is `{ a: 1, b: 9 }`
- **THEN** `b` is listed before `a`
- **AND** an empty map renders the unmeasured marker rather than an empty cell

### Scenario: a null overview compliance rate is unmeasured

- **GIVEN** a user with `compliance_rate === null`
- **THEN** the cell reads as unmeasured, distinctly from `0%`

---

## Requirement 5 — Charts degrade honestly and are sized to their content

### Scenario: an empty distribution says it is empty

- **GIVEN** a bar chart whose data object has no keys
- **THEN** it renders a "no data" line rather than an empty box

### Scenario: bars are proportional to the largest value

- **GIVEN** `{ a: 5, b: 10 }`
- **THEN** `b` is 100% wide and `a` is 50%
- **AND** rows are ordered by count descending

### Scenario: a max of zero does not divide by zero

- **GIVEN** every value is 0
- **THEN** each bar's width is 0 and no `NaN` reaches the DOM

### Scenario: short charts sit in pairs

- **GIVEN** a chart block with three or four rows
- **THEN** it is laid out beside a sibling, not spanning the full width
- **AND** the main column is width-capped

---

## Requirement 6 — The context section explains its own absence

### Scenario: no context data states the reason

- **GIVEN** the server returns `context: null`
- **THEN** 常用操作 / 專案分布 / 使用者痛點 / AI 改善建議 render a sentence naming why
  they are empty
- **AND** they are not hidden without explanation

### Scenario: context present but a sub-list empty

- **GIVEN** `context.sessions_with_context > 0` but `friction_points` is `[]`
- **THEN** that block alone says no friction was reported
- **AND** the sibling blocks still render their data

---

## Requirement 7 — Labels are translated through i18n, not a hardcoded Chinese map

The legacy page maps event and type keys to Chinese through a literal `ZH` object
(`src/public/index.html:1055-1071`). Copying it into the console would put Chinese
strings into a build that also serves `en` and `ja`.

### Scenario: a known key resolves through the locale dictionary

- **GIVEN** the key `iron_rule`
- **THEN** the label comes from the active locale's dictionary

### Scenario: an unknown key falls back to itself

- **GIVEN** a key with no dictionary entry
- **THEN** the raw key is displayed
- **AND** no error is thrown and no `undefined` reaches the DOM

---

## Requirement 8 — The manifest entry flips and `/admin/` stays served

### Scenario: stats-dashboard is live

- **THEN** `stats-dashboard` has `state: 'live'`
- **AND** `/team/stats` renders the real page, not a signpost
- **AND** the amber marker beside 統計儀表板 in the sidebar is gone

### Scenario: two signposts remain

- **THEN** exactly `team-usage` and `periodic-reports` are still signposts
- **AND** `/admin/` is still mounted rather than redirecting

### Scenario: the page is admin-gated, matching its nav item

- **GIVEN** a session whose role is `user`
- **WHEN** `/team/stats` is requested directly
- **THEN** the role guard redirects, as it does for every other admin item
