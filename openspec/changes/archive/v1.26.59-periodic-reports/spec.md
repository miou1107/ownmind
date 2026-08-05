# v1.26.59 — 週報月報 spec

Refines the umbrella `single-console-consolidation` spec for Stage 7. Requirements 3
(lose no feature), 5 (retirement is a consequence) and 7 (absence ≠ zero) all bind here;
what follows is what they mean for this page.

## Requirement A — The report page exists in the console, for every member

### Scenario: a member reaches their own report

- **GIVEN** an account with role `user`
- **WHEN** they open `/portal/periodic-reports`
- **THEN** the page renders their own report
- **AND** no role guard redirects them, because `GET /api/session/report` filters by
  `req.user.id` and has always been personal data

### Scenario: the signpost is gone

- **GIVEN** the manifest entry `periodic-reports` is `live`
- **WHEN** the navigation renders
- **THEN** 週報月報 carries no amber signpost marker
- **AND** the route renders the real page rather than `<Signpost>`

### Scenario: every legacy block is present

- **GIVEN** the legacy tab's blocks: 新增記憶, 自動建立 Friction Issue, 自動建立
  Suggestion Action, Top Frictions, Top Suggestions, the week/month switch, and offsets
  0 through 3
- **WHEN** the console page renders
- **THEN** all of them are present
- **AND** clicking a friction or suggestion row opens the memory-search modal, as it does
  in the legacy tab

## Requirement B — The Suggestion Action count is measured, not omitted

### Scenario: the count is emitted

- **GIVEN** memories tagged `['suggestion-action','auto-generated']` created inside the
  period
- **WHEN** `GET /api/session/report` responds
- **THEN** the response carries `suggestion_actions_created` equal to that number
- **AND** it is counted the same way `friction_issues_created` is, so the two cards cannot
  disagree about what "created in this period" means

### Scenario: none created is zero, not absent

- **GIVEN** no such memory in the period
- **THEN** `suggestion_actions_created` is `0`
- **AND** the card renders `0`, because the query ran and found nothing — this is a real
  zero, not missing data

### Scenario: the two created-counts say which period they describe

- **GIVEN** the weekly job creates issues for the *previous* period, so a creation lands
  in the window after the one that produced it
- **WHEN** the two cards render
- **THEN** the page states that they count what was created during this period
- **AND** it does not imply the issues were distilled from this period's frictions

## Requirement C — An empty list names which emptiness it is

The legacy page prints one sentence for four situations. Each gets its own.

### Scenario: no session was logged at all

- **GIVEN** `sessions_total` is 0 for the period
- **THEN** the lists say no session was recorded in this period
- **AND** they do not say there were no frictions, because that was never measured

### Scenario: sessions were logged but carried no detail

- **GIVEN** `sessions_total` is greater than 0 and `sessions_analyzed` is 0
- **THEN** the lists say sessions were recorded but none carried the reflection fields
- **AND** the count of sessions seen is stated, so the reader can tell it is a reporting
  gap rather than an idle period

### Scenario: sessions were analysed and contained no friction

- **GIVEN** `sessions_analyzed` is greater than 0 and `top_frictions` is empty
- **THEN** the list says this period genuinely recorded no friction
- **AND** it states how many sessions that conclusion is drawn from

### Scenario: the period predates the retention window

- **GIVEN** `period_end` is earlier than `detail_retention_cutoff`
- **WHEN** the page renders
- **THEN** it states that session detail for this period has been compressed away and the
  lists cannot be complete
- **AND** it says so whether or not the lists happen to be empty, because a partially
  compressed window returns a partial list that looks like a whole one

### Scenario: a partly-expired period is still flagged

- **GIVEN** `period_start` is earlier than `detail_retention_cutoff` but `period_end` is
  not
- **THEN** the same caveat is shown, because the earlier days of the window are already
  gone

## Requirement D — Retirement happens by flipping the entry, and is observed

### Scenario: the manifest empties

- **GIVEN** `periodic-reports` flips from `signpost` to `live`
- **THEN** `signpostFeatures()` returns an empty array
- **AND** `isLegacyConsoleRetired()` returns true

### Scenario: `/admin` stops being served

- **GIVEN** a retired manifest
- **WHEN** `GET /admin/` is requested
- **THEN** the response is a redirect, not the legacy console
- **AND** the redirect is relative, per Requirement 4, so it survives the `/ownmind`
  reverse-proxy prefix

### Scenario: the end-to-end suite asserts retirement rather than skipping

- **GIVEN** no feature is signposted
- **WHEN** the end-to-end suite runs
- **THEN** the signpost specs skip, as designed
- **AND** a mirror spec runs in their place asserting that `/admin/` redirects
- **AND** the two are mutually exclusive, so exactly one of them covers the state the
  manifest is actually in

## Requirement E — The request is guarded like every other refetching page

### Scenario: switching period while a request is in flight

- **GIVEN** a report request is in flight
- **WHEN** the period or offset changes and a second request is issued
- **THEN** the first response is discarded when it arrives late
- **AND** the page never shows one period's numbers under another period's label

This is the v1.26.56 Critical and the v1.26.58 Important in a third place; the guard is
the existing `makeRequestGate`, not a new one.
