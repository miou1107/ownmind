# Spec — a tag nothing asks for is said out loud

## Requirement 1 — unreachable trigger tags are identified

### Scenario: a tag naming a word no trigger uses

- **GIVEN** tags containing `trigger:wrap-up`, `trigger:debug` or `trigger:身分`
- **THEN** each is reported

These are verbatim from the 2026-08-12 sweep of the live account.

### Scenario: every word the matcher honours

- **GIVEN** any word in `TRIGGER_TAG_ALIASES`, any canonical trigger name, or `command`
- **THEN** it is **not** reported

The check and the matcher must agree by construction. A warning about a tag that works is
worse than no warning: it teaches the author to ignore the next one.

### Scenario: case

- **GIVEN** `trigger:DEPLOY`
- **THEN** it is not reported

`ruleMatchesTrigger` lowercases before comparing, so this tag works.

### Scenario: ordinary labels

- **GIVEN** `security`, `workflow`, `auto_created`
- **THEN** none is reported

Only `trigger:`-prefixed tags are judged. Everything else is a free-text label for search and
grouping and has no vocabulary to be wrong about.

### Scenario: the shapes a caller can actually send

- **GIVEN** `undefined`, `null`, a bare string, or an array containing non-strings
- **THEN** nothing throws, and only genuine offending strings come back

## Requirement 2 — the author is told at the moment of writing

### Scenario: creating

- **GIVEN** a create request whose tags include an unreachable trigger tag
- **THEN** the memory is created
- **AND** the response carries a `warning`

### Scenario: updating

- **GIVEN** the same on update
- **THEN** the same

`tags` REPLACES rather than merges on update, so it is exactly where a working tag is dropped
or a dead one introduced.

### Scenario: the tag is not refused

- **THEN** the status code is unchanged and the write succeeds

Seven of the nine memories found are deliberately untagged — they name a kind of work rather
than an operation. Refusing the tag would make those rows uneditable for any unrelated reason.

## Requirement 3 — what the warning has to contain

- the offending tags, **verbatim and in the order given** — the author has to find the string
  they typed
- what will happen: the memory will not come up on its own
- the triggers that do exist, so a correct one can be chosen
- that no trigger tag at all is a legitimate answer

The last point matters because usually nothing is wrong. A memory reached by name — "I'm
wrapping up" — needs no trigger tag, and a warning that reads as an error would push the
author into inventing one.

## Requirement 4 — the vocabulary is derived

`KNOWN_TRIGGER_WORDS` MUST be built from `TRIGGER_TAG_ALIASES` rather than restated. A second
hand-written list is the same defect one level up: it drifts, and then warns about tags that
work.

## Out of scope

Finding the memories that already carry a dead tag. This stops new ones from being created
silently; it does not scan the existing set. All nine were found by hand, on request, and a
detector for them is a separate change.
