# v1.26.129 — Spec

## Requirement: lib modules run where their imports resolve

The session hook MUST invoke every `hooks/lib` module through a directory whose parent
contains `shared/`, preferring the checkout.

### Scenario: a module imports from shared/

- **GIVEN** `render-session-context.js` imports `../../shared/tips.js`
- **WHEN** the session hook renders the context
- **THEN** it loads, because the module ran from the checkout

### Scenario: a call site is changed back to the script-relative path

- **GIVEN** any `$LIB_DIR/…` invocation is rewritten to `$SCRIPT_DIR/lib/…`
- **WHEN** the suite runs
- **THEN** it fails, naming that call site

### Scenario: the broken layout still breaks

- **GIVEN** the lib modules copied into a directory with no `shared/` sibling
- **WHEN** one of them is executed
- **THEN** it fails with a module-resolution error — the guard asserts the failure it
  protects against rather than trusting a string in the hook

## Requirement: the background update reports what it did

Every terminal outcome of the daily update MUST queue a message for the next session, except
"already up to date".

### Scenario: the update succeeds

- **GIVEN** the background update pulls a new version
- **WHEN** the user opens their next conversation
- **THEN** they are told the new version number and that no action is needed

### Scenario: the update fails

- **GIVEN** it fails at any step
- **WHEN** the user opens their next conversation
- **THEN** they are told which step in plain words, and offered a bug report — because the
  failure happened in a detached process they cannot reach

### Scenario: a step with no plain-words label

- **GIVEN** a failure at a step this module has no wording for
- **WHEN** the banner is built
- **THEN** the raw step name is reported rather than the message being dropped

### Scenario: there was no new version

- **GIVEN** the machine is already current
- **WHEN** the update finishes
- **THEN** nothing is queued, so silence keeps meaning "nothing happened"

### Scenario: the new version cannot be read off disk

- **GIVEN** a successful update whose `package.json` version reads as unknown
- **WHEN** the banner is built
- **THEN** nothing is queued — a message naming no version is worse than none

## Requirement: the upgrade reminder only fires when the automation is stuck

The nightly reminder MUST NOT target clients that are merely not on the newest build.

### Scenario: a user one release behind

- **GIVEN** the daily updater is working normally
- **WHEN** the reminder is generated
- **THEN** that user is not targeted

### Scenario: a user many releases behind

- **GIVEN** a client at least `LAG_PATCHES` behind
- **WHEN** the reminder is generated
- **THEN** that user is targeted, and the message says the automation is not working rather
  than announcing a release

### Scenario: an early patch of a new minor

- **GIVEN** a server on `1.27.3`, where subtracting the lag would go below zero
- **WHEN** the threshold is computed
- **THEN** it is `1.27.0-prev`: clients still on the previous minor are reminded, clients on
  the new minor are not
