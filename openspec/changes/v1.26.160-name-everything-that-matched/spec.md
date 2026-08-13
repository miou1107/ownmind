# Spec — the listing names every category that matched

## Requirement 1 — no category with a match shows a bare count

### Scenario: the once-an-hour listing

- **GIVEN** a hook operation whose window is open, so the full listing is printed
- **WHEN** a category matched one or more memories
- **THEN** its names MUST appear in the listing
- **AND** this MUST include `iron_rule`

A count with no names beside categories that have them reads as a category that found nothing.
That is the opposite of what a count of two means.

### Scenario: a category that matched nothing

- **GIVEN** a category whose count is zero
- **THEN** it gets no name row

Unchanged from v1.26.154. A heading with nothing under it is the shape people learn to skip.

### Scenario: the throttled operations

- **GIVEN** an operation inside an hour whose listing has already been printed
- **THEN** the counts line goes out alone, as before

Unchanged. The window is what keeps the listing from becoming wallpaper, and widening the
listing does not change how often it appears.

## Requirement 2 — the banner still prints, and prints the same rules

### Scenario: any trigger that carries matching iron rules

- **THEN** the ⚠️ banner MUST still list them with their codes
- **AND** the requirement that the reply's first line repeats the banner is unchanged

The listing and the banner overlap on purpose. The listing reports what was found; the banner
is what stops you. Deleting one because the other says something similar loses the job the
deleted one was doing.

## Requirement 3 — all three callers, proven separately

### Scenario: each hook entry point

- **GIVEN** `ownmind-edit-reminder.js`, `ownmind-iron-rule-check.js`, or
  `ownmind-render-context.js`
- **THEN** each MUST be exercised by its own case

One protocol with three implementations drifts in whichever copy nobody edited. Asserting the
shared renderer proves nothing here: the renderer never held the exclusion, the callers did.

### Scenario: the test must fail against the previous commit

- **WHEN** the change is verified
- **THEN** the new test MUST be run against the code before it and MUST fail

The behaviour it replaces had no test at all. A test written after the fact that passes both
ways records nothing.

## Out of scope

The window, the counts line, the denominators, the order of categories, and the banner's
wording. And the wider question of whether the banner and the listing should eventually merge
— that is a design change, not this.
