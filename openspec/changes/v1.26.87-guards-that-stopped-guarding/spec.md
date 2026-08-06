# v1.26.87 follow-ups — Spec

## ADDED Requirement: the iron-rule response is parsed in one place

`hooks/lib/iron-rule-sync.js` SHALL be the only place that decides how the iron-rule API
response is shaped, and both Node consumers SHALL import it rather than carry a copy.

### Scenario: the shape the server actually sends

- **GIVEN** a body of `{"data": [ ...rules... ]}`
- **THEN** the parser returns the rules

Read as a bare array — the pre-v1.26.87 behaviour — this yields zero rules, and zero rules
means every check is skipped.

### Scenario: a bare array still works

- **GIVEN** a body that is a JSON array
- **THEN** the parser returns it

Kept so the fix does not break if the endpoint is ever unwrapped again.

### Scenario: anything else

- **GIVEN** unparseable text, an empty body, or an object without a `data` array
- **THEN** the parser returns an empty array and does not throw

A sync failure must never abort a commit.

## ADDED Requirement: a sync that returns nothing never overwrites the cache

### Scenario: the sync comes back empty

- **GIVEN** a fetch that produces zero usable rules
- **THEN** the cache file is left exactly as it was

Before this change the empty result was written to disk. The run that wrote it still had
the old rules in memory and behaved normally; the NEXT commit read the empty cache, found
nothing to check, and exited silently. One failed refresh disarmed everything.

### Scenario: the sync returns rules

- **GIVEN** a fetch that produces at least one usable rule
- **THEN** the cache is replaced with it

## ADDED Requirement: the bash iron-rule check survives the envelope

`hooks/ownmind-iron-rule-check.sh` SHALL unwrap `{ data: [...] }` before filtering.

### Scenario: the installed variant

- **GIVEN** the wrapped body
- **THEN** the embedded script filters the rules rather than throwing

Calling `.filter` on the envelope throws `TypeError`, the embedded `node -e` dies, and the
surrounding command substitution swallows it — so this hook produced no reminders at all.
This is the variant referenced by a real installation's `settings.json`.

## ADDED Requirement: credentials found only in the environment are written to a file

When the key resolves from the process environment and no file, the installers SHALL write
it into `~/.claude/settings.json` under `mcpServers.ownmind.env`, so scheduled runs and the
SessionStart hooks can read it.

The helper SHALL write to a temporary file and rename, SHALL refuse to modify a config it
cannot parse or that is not an object, and SHALL report the reason instead.

### Scenario: the machine this exists for

- **GIVEN** the key present only as `OWNMIND_API_KEY` in the environment
- **THEN** it is written into the settings file
- **AND** the outcome is `repaired`

### Scenario: the user has opted out

- **GIVEN** `~/.ownmind/.no-key-file` exists
- **THEN** nothing is written and the outcome is `opted_out`

### Scenario: a config that cannot be understood

- **GIVEN** a settings file that is not valid JSON, or is valid JSON but not an object
- **THEN** nothing is written, the outcome is `error`, and the file is byte-for-byte unchanged

Repairing one key must never cost the user their other settings.

## ADDED Requirement: the repair's outcome is reported at the right volume

The self-check SHALL carry an item reporting the repair, mapped so that only a genuine
failure reaches a human.

### Scenario: repaired or already safe

- **THEN** the item is `pass`, and the detail says which of the two it was

### Scenario: opted out, or no credentials at all

- **THEN** the item is `warn`

`warn` is deliberate: the alerting added in this same version broadcasts new `fail` items to
the super admin and ignores `warn`. A deliberate opt-out must not nag, and a missing key is
already reported by `api_key_format`.

### Scenario: the repair was attempted and failed

- **THEN** the item is `fail`, carrying the reason and an actionable fix

This is the one outcome a human needs to see, and `fail` is what reaches them.

### Scenario: the installer prints what happened

- **WHEN** any of the four install/update scripts runs the repair
- **THEN** its one-line summary is printed, and the label follows the exit code

A failure must not print as `[ OK ]`. The summary names locations, never the key.

## ADDED Requirement: source files carry no invisible characters

Files under `src/`, `scripts/install-helpers/` and `hooks/` SHALL contain no control bytes
and no literal invisible characters (U+FEFF, the zero-width range, U+2060, U+00A0). Regexes
that need them SHALL use escapes.

### Scenario: a literal U+FEFF in a character class

- **GIVEN** a regex carrying the character itself rather than `\uFEFF`
- **THEN** the guard fails and names the file

It works today. It stops working the first time an editor normalises invisible characters,
and the diff shows nothing worth a second look.
