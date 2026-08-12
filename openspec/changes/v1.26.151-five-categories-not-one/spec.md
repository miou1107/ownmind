# Spec — five categories, not one

## Requirement: one request returns every category the reminder names

`GET /api/memory/hook-context?trigger=<trigger>` returns
`{ data: { trigger, counts, rules } }`, where `counts` has a key for each of the five types in
`HOOK_CONTEXT_TYPES` and `rules` carries `{ code, title }` for matching iron rules only.

### Scenario: a hook prepares a reminder

- **WHEN** the shell hook classifies a command as `deploy`
- **THEN** it makes exactly one request to a memory endpoint
- **AND** the response covers all five categories

### Scenario: a type outside the five

- **WHEN** the account holds `project`, `env`, `standard_detail`, `session_log` or `portfolio`
- **THEN** none of them appear in `counts`, whatever their tags say

`project` and `env` record what something is; the reminder is about what constrains the
operation. `standard_detail` is the body text of a team standard already counted one row up.

## Requirement: untagged rows do not flood the four new categories

`ruleMatchesTrigger(rule, trigger, { untaggedMatchesAll })` defaults to `true`, the
pre-existing contract. `tallyHookContext` passes `true` for `iron_rule` and `false` for the
other four.

### Scenario: an untagged principle

- **WHEN** a `principle` row has no trigger tags and a `commit` is about to run
- **THEN** it is not counted

### Scenario: an untagged iron rule

- **WHEN** an `iron_rule` row has no trigger tags
- **THEN** it is counted, for every trigger, exactly as before

## Requirement: the line says what is happening, in the user's words

### Scenario: credential work

- **WHEN** the trigger is `install`
- **THEN** the line reads `安裝／金鑰` and the word `install` does not appear

### Scenario: a category matched nothing

- **WHEN** `profile` matched 0 rows and another category matched some
- **THEN** `個人偏好 0` is printed

The zero distinguishes "consulted, matched nothing" from "never asked" — the distinction the
old display could not express. It does not contradict the edit reminder's silence at
`rule_count` 0: that is about the total, this is one row inside a listing that already has
content.

### Scenario: nothing matched anywhere

- **WHEN** every category is 0
- **THEN** nothing is printed at all

## Requirement: an older server degrades visibly, not silently

### Scenario: the server predates the endpoint

- **WHEN** `/hook-context` answers anything other than 200
- **THEN** the hook requests `/type/iron_rule` and renders the pre-v1.26.151 banner
- **AND** writes `hook_context_fallback` to the activity log
- **AND** does **not** print the other four categories as zeroes

Zeroes there would claim four categories were consulted and empty when they were never
asked — the same confusion this change exists to remove, restated by the fix.

### Scenario: a 200 whose body is in neither shape

- **WHEN** the response is valid JSON with no `counts` and no array
- **THEN** `ownmind-render-context.js` exits non-zero and prints nothing to stdout
- **AND** the shell records `render_context_failed`

Silence here is indistinguishable from "no rules apply", which is the most common true
answer and therefore the best hiding place a defect could ask for.

## Requirement: the throttled edit path still makes no request

The hourly window carries `counts` alongside `rule_count`.

### Scenario: the second edit within the hour

- **WHEN** an edit falls inside an open window written by v1.26.151 or later
- **THEN** the one-line reminder names all five categories
- **AND** no network request is made

### Scenario: a window written by an older client

- **WHEN** the stored entry has no `counts`
- **THEN** the pre-v1.26.151 single-count line is printed until the window refreshes

`isEntry` does not require `counts`, so an old state file still reads rather than being
discarded — discarding it would re-list on the next edit and pay a round trip for it.

## Requirement: the shell hook holds no copy of the matching rules

### Scenario: a new trigger alias is added

- **WHEN** a word is added to `TRIGGER_TAG_ALIASES`
- **THEN** the shell hook accepts it with no shell-side edit

The hook delegates to `hooks/ownmind-render-context.js`, which imports `ruleMatchesTrigger`.
`tests/iron-rule-trigger-aliases.test.js` now asserts the absence of an inline table rather
than the agreement of two.
