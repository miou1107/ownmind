# v1.26.56 — 統計儀表板 (Stage 5)

## Why

Stage 5 of `single-console-consolidation`. 統計儀表板 is the page Vin actually uses,
and it is the largest single stage: seventeen blocks across two views, backed by three
`/api/activity/*` endpoints **the console has never called before**. This is a new
integration, not a move.

After this ships, two signposts remain (`team-usage`, `periodic-reports`) and `/admin/`
stays served.

## What the inventory found

Read directly off `src/public/index.html:292-369` (markup) and `:2777-3010` (render JS),
plus all three endpoints in `src/routes/activity.js`.

### Two views, one control bar

`loadUserStats()` branches on the user select: empty value → overview
(`GET /activity/stats/all?days=`), a user id → detail
(`GET /activity/stats?user_id=&days=` followed by
`GET /activity/stats/rules?user_id=&days=`). Range is a fixed 7 / 30 / 90 select,
defaulting to 30. The user dropdown is filled from `usersData`, the same
`/api/admin/users` list the team page already loads.

### The seventeen blocks

| # | Block | Source field |
|---|---|---|
| 1 | 用戶活躍度總表 | `stats/all` → `users[]` (overview view) |
| 2 | 記憶數量卡片 | `memory.*`, `sessions.total`, `activity.total_events`, `iron_rules.*` |
| 3 | 記憶類型分布 | `memory.by_type` |
| 4 | 工具分布 | `sessions.by_tool` |
| 5 | 模型分布 | `sessions.by_model` |
| 6 | 每日活動量 | `activity.daily` |
| 7 | 鐵律合規率 | `compliance.rate`, `compliance.by_action` |
| 8 | 各規則落地率 | `compliance.by_rule` |
| 9 | 各工具落地率 | `compliance.by_tool` |
| 10 | 每條鐵律落地率表 | `stats/rules` → `rules[]` |
| 11 | 從未被觸發的規則 | `stats/rules` → `summary.rules_never_tested` |
| 12 | 鐵律觸發 Top 5 | `iron_rules.top_triggered` |
| 13 | 系統健康 | `health.*` |
| 14 | 常用操作 | `context.top_actions` |
| 15 | 專案分布 | `context.top_projects` |
| 16 | 使用者痛點 | `context.friction_points` |
| 17 | AI 改善建議 | `context.suggestions` |
| — | 交接統計 | `handoffs.*` |

That is eighteen rows because the umbrella list names 交接統計 as one of the
seventeen while also listing 用戶活躍度總表; the two views are counted together. All
of it is ported.

## Corrections to the umbrella task list

**The memory-search modal does not belong to this stage.** The umbrella tasks say "the
memory-search modal the friction and suggestion lists link to
(`src/public/index.html:1476-1500`, `/api/memory/search`) comes along or is explicitly
dropped". Grepping `data-search-text` returns exactly two call sites, at `:2750` and
`:2761` — both inside `loadReport()`, the **週/月報** tab. The stats tab's
`frictionList` / `suggestionList` render plain `<div>`s with no `data-search-text`
attribute and no click handler, so nothing on this page opens that modal. It is
Stage 7's decision, not this stage's.

## Requirement 7 in this stage

Four concrete applications, three of which fix a defect in the legacy page.

1. **A null compliance rate is not a red zero.** `compliance.rate` is `null` when the
   period has no compliance events at all. The legacy 各規則落地率 and 各工具落地率
   blocks compute `const rate = t > 0 ? ... : 0` and then band it — `0 >= 90` false,
   `0 >= 70` false, so an unmeasured rule paints solid red at 0%. That is exactly the
   failure Requirement 7 exists to stop: "we never observed this" rendered as "this
   fails every time". Null takes its own branch, with no colour band.

2. **從未被觸發的規則 stays a separate statement.** Carried over from the umbrella
   list: with 88 active rules and few triggered in any week, folding the untriggered
   ones into the denominator manufactures a low score out of an absence of evidence.

3. **The context section states why it is empty instead of vanishing.**
   `getContextAnalysis()` returns `null` when no session in the period carried a
   `details` payload, and the legacy page responds by hiding four blocks with
   `classList.add('hidden')`. A block that silently disappears is an unexplained
   absence. It now renders a sentence naming the reason.

4. **Charts are sized to their content.** Requirement 7's last scenario: blocks with
   three or four rows sit beside a sibling rather than spanning full width, and the
   main column is capped so a two-digit count is never 1500px from its label.

## Known limitation, recorded not hidden

`getContextAnalysis()` is wrapped in `try { … } catch { return null }`
(`src/routes/activity.js:38,80`). A failed query and a genuine absence of context data
both arrive at the client as `context: null`, and nothing in the payload distinguishes
them. The page therefore says "no session in this period reported context data", which
is the *likely* reading but not a proven one. Fixing it means changing the endpoint to
report the error, which is server work outside this stage's scope. Filed rather than
papered over.

## Scope

- **In:** `/team/stats` at admin+, both views, all blocks, the manifest flip.
- **Out:** any change to `src/routes/activity.js`. Requirement 3 — same endpoints,
  unchanged. The `context: null` ambiguity above is the one thing this constraint
  costs, and it is recorded.
- **Out:** the memory-search modal (belongs to Stage 7, see above).
