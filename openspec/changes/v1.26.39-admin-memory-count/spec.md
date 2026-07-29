# v1.26.39 — Spec: admin memory-count card

> Companion to `proposal.md`. Observable behaviour in GIVEN / WHEN / THEN form.

---

## Requirement 1 — The card SHALL show the real memory count

The admin dashboard MUST render the number of memories the `/export` payload
reports, not a count derived from a shape the endpoint does not produce.

### Scenario 1.1 — current payload

- **GIVEN** `/export` responds with `total_count` of 387 and a `memories`
  object grouped by type
- **WHEN** the dashboard loads
- **THEN** the card shows `387`

### Scenario 1.2 — the authoritative field wins

- **GIVEN** a payload whose `total_count` is 387 while its grouped object holds
  3 rows
- **WHEN** the count is computed
- **THEN** the result is 387, because grouped lengths must never override the
  count the server reports

---

## Requirement 2 — An unexpected payload shape SHALL still produce a count

If `total_count` is ever absent, the dashboard MUST fall back to counting rows
rather than silently reporting zero.

This is defence, not compatibility: `total_count` has been in the response
since the first commit, and the page is served by the process it calls, so
client and server are always the same version. The requirement exists so a
future payload change degrades visibly instead of regressing into this bug.

### Scenario 2.1 — grouped object without a total

- **GIVEN** a payload of `{ memories: { iron_rule: [3 rows], project: [2 rows] } }`
- **WHEN** the count is computed
- **THEN** the result is 5

### Scenario 2.2 — flat `type -> array` payload

- **GIVEN** a payload whose top level is `type -> array`
- **WHEN** the count is computed
- **THEN** the result is the sum of those array lengths

### Scenario 2.3 — memories as a plain array

- **GIVEN** a payload of `{ memories: [3 rows] }`
- **WHEN** the count is computed
- **THEN** the result is 3, because `Object.values` over an array yields the
  rows themselves and would otherwise count nothing

---

## Requirement 3 — Malformed input SHALL count zero without throwing

A bad payload MUST NOT raise, because an exception would render `-` and hide
the fact that the response arrived.

### Scenario 3.1 — empty and non-object input

- **GIVEN** `{}`, `{ memories: {} }`, `null`, `undefined`, or a string
- **WHEN** the count is computed
- **THEN** the result is `0` and nothing is thrown

### Scenario 3.2 — non-numeric total_count

- **GIVEN** a payload whose `total_count` is a string, alongside a grouped
  object holding 1 row
- **WHEN** the count is computed
- **THEN** the fallback applies and the result is 1

### Scenario 3.3 — an explicit zero is a real count

- **GIVEN** a payload with `total_count: 0` whose grouped object nonetheless
  holds 2 rows
- **WHEN** the count is computed
- **THEN** the result is `0`
- **AND** the fixture must keep those 2 rows, so that a `total_count > 0` style
  guard answers 2 and is caught; an empty grouped object would answer 0 either
  way and prove nothing

### Scenario 3.4 — a non-finite total is not a count

- **GIVEN** a payload whose `total_count` is `NaN` or `Infinity`, alongside a
  grouped object holding 1 row
- **WHEN** the count is computed
- **THEN** the fallback applies and the result is 1

---

## Requirement 4 — A failed request SHALL stay visually distinct from zero

The dashboard MUST keep rendering `-` when the request itself fails, so
"cannot tell" never reads as "none".

### Scenario 4.1 — request rejects

- **GIVEN** the `/export` request throws
- **WHEN** the dashboard loads
- **THEN** the card shows `-`

### Scenario 4.2 — server answers with an error status

- **GIVEN** `/export` responds 401 or 500 with a JSON error body
- **WHEN** the dashboard loads
- **THEN** the card shows `-`
- **AND** it does NOT show `0`, because that body parses cleanly and would
  otherwise count as zero — the exact symptom this change removes

---

## Requirement 5 — The label SHALL state whose rows it counts and which ones

Because `/export` is scoped to the caller AND filters `status = 'active'`, the
card MUST NOT be labelled in a way that reads as system-wide, nor reuse a word
the same console already applies to a figure that includes disabled rows.

### Scenario 5.1 — qualified on both axes

- **GIVEN** the stat row containing 使用者總數, which counts every account
- **AND** the statistics tab, which labels 記憶總數 a figure of 418 that
  includes disabled rows, while this card shows 387 active ones
- **WHEN** the memory card is rendered
- **THEN** its label names both the signed-in user and the active-only scope
- **AND** it does not reuse the bare word 總數
