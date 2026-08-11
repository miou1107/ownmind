# v1.26.140 — Spec delta: an empty file is content, and a busy gateway is not an answer

## ADDED Requirement: the upgrade rule SHALL be written whatever state the target file is in

Writing the OwnMind upgrade rule into another AI tool's instruction file SHALL succeed for
every state that file can be in, and SHALL leave the user's own content intact.

### Scenario: the tool's instruction file exists but is empty

- **GIVEN** `~/.gemini/GEMINI.md` exists and is zero bytes
- **WHEN** the updater syncs the upgrade rules
- **THEN** the file receives the rule block
- **AND** nothing is thrown

### Scenario: the tool's instruction file does not exist yet

- **GIVEN** the tool's directory exists and the file does not
- **WHEN** the updater syncs the upgrade rules
- **THEN** the file is created carrying the rule block

### Scenario: the file already holds the user's own instructions

- **WHEN** the updater syncs the upgrade rules
- **THEN** the user's content is still there
- **AND** the rule block is appended after it

### Scenario: the updater runs a second time

- **GIVEN** a file that already carries a rule block from an earlier run
- **WHEN** the updater syncs the upgrade rules again
- **THEN** exactly one rule block is present
- **AND** it holds the current rule, not the previous one

### Scenario: the tool is not installed

- **GIVEN** the tool's directory does not exist
- **WHEN** the updater syncs the upgrade rules
- **THEN** the file is not created
- **AND** the result is reported as skipped rather than written

### Scenario: the file is read by another vendor's tool

- **WHEN** the updater writes the file
- **THEN** the bytes are UTF-8 with no byte order mark

### Scenario: the user's file holds non-ASCII text

- **GIVEN** the file holds the user's own instructions in Chinese
- **WHEN** the updater runs, and runs again afterwards
- **THEN** that text is byte-identical to what the user wrote
- **AND** this holds where a BOM-less file would otherwise be decoded by the system code page

## ADDED Requirement: the updater SHALL report what actually happened

### Scenario: every tool synced

- **THEN** the summary line states how many tools were written

### Scenario: one tool failed

- **WHEN** writing to one of the targets throws
- **THEN** the summary is a warning rather than `[ OK ]`
- **AND** it names the target that failed and why
- **AND** the remaining targets are still attempted

### Scenario: the helper is missing from the checkout

- **WHEN** `scripts/windows/lib/append-upgrade-rule.ps1` is not present
- **THEN** the step is reported as skipped rather than passed over in silence

## ADDED Requirement: the same reporting SHALL hold on macOS, Linux and Git Bash

`scripts/update.sh` does not share the null crash, but it did share the summary line.

### Scenario: the strip step could not run

- **GIVEN** Node cannot be executed
- **WHEN** the updater syncs the upgrade rules
- **THEN** that target is reported as failed rather than counted as written
- **AND** the remaining targets are still attempted

### Scenario: nothing is installed

- **THEN** the summary says zero tools, not "synced to detected AI tools"

## MODIFIED Requirement: an upstream that is momentarily busy SHALL NOT surface as a failed report

Supersedes the v1.26.137 statement that the gateway enforces a fixed 40 KiB request ceiling.
Measured 2026-08-11: a 40,214-byte body was accepted while the route's 35,301-byte body was
refused minutes earlier, and that same refused body then succeeded on six consecutive
replays. The refusal tracks the gateway's spare capacity, not the request's size.

### Scenario: the gateway refuses once and then recovers

- **GIVEN** the gateway answers 502 to the first attempt
- **WHEN** insights are requested
- **THEN** the request is attempted again
- **AND** the report is returned

### Scenario: the gateway rejects the request itself

- **GIVEN** the gateway answers 400, 401, 403 or 404
- **WHEN** insights are requested
- **THEN** the request is attempted exactly once
- **AND** the error is surfaced without delay

### Scenario: the gateway has stopped answering

- **WHEN** attempts stall rather than refuse
- **THEN** retrying stops at the overall deadline
- **AND** no single attempt is allowed to run past it
- **AND** no attempt is started once the deadline has already passed
- **AND** the error states how many attempts were spent
- **AND** the error is readable — a genuine abort must not be turned into a TypeError by the
  code that annotates it

### Scenario: the gateway answered, but not with the JSON that was asked for

- **WHEN** the response parses as HTTP 200 and its content is not the expected JSON
- **THEN** the request is attempted exactly once
- **AND** this holds whatever words appear in the model's reply

### Scenario: every provider behind the gateway refused

- **WHEN** the failure is logged
- **THEN** the reason each provider gave is legible, not cut off after the first one
