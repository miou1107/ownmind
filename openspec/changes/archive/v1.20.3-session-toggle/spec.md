# v1.20.3 — Spec: session temporary off switch

## Scenario 1: write state file → lint hook skips in the same session

**GIVEN** session_id = "S1"
**AND** `ownmind_session_off` is called (with session_id="S1")
**WHEN** the Stop hook runs, payload.session_id = "S1"
**THEN** the hook skips the lint check
**AND** the hook exit code = 0
**AND** the state file `tick_count` increments from 0 to 1

## Scenario 2: new session auto-invalidates

**GIVEN** the state file contains session_id="S1"
**WHEN** the Stop hook runs, payload.session_id = "S2" (different session)
**THEN** the hook treats it as invalidated and runs lint normally
**AND** the state file is cleared (plain English: deleted)

## Scenario 3: remind every 10 turns

**GIVEN** the state file's tick_count = 9
**WHEN** the Stop hook runs, same session
**THEN** tick_count increments to 10
**AND** it attempts to use `writeToTty` to write the reminder "⚠️ OwnMind 目前關閉中、請記得 /ownmind-on 重開（已關閉 10 輪）"

## Scenario 4: do not remind before reaching 10 turns

**GIVEN** the state file's tick_count = 5
**WHEN** the Stop hook runs, same session
**THEN** tick_count increments to 6
**AND** no reminder is written

## Scenario 5: pre-commit hook skips

**GIVEN** the state file exists, off_at is 1 hour ago
**WHEN** the pre-commit hook runs
**THEN** all iron-rule checks are skipped
**AND** it prints "⚠️ OwnMind 目前關閉中、commit 放行"
**AND** exit code = 0 (commit allowed)

## Scenario 6: state file expired (24 hours ago)

**GIVEN** the state file's off_at is 25 hours ago
**WHEN** the pre-commit hook runs
**THEN** it is treated as invalidated and checks run normally
**AND** the state file is cleared

## Scenario 7: ownmind_session_on clears state

**GIVEN** the state file exists
**WHEN** `ownmind_session_on` is called
**THEN** the state file is deleted
**AND** the ack returned contains "OwnMind 已重新開啟"

## Scenario 8: ownmind_session_off when already off

**GIVEN** the state file already exists, session_id="S1"
**WHEN** `ownmind_session_off` is called again (same session_id="S1")
**THEN** the state file is unchanged (tick_count preserved)
**AND** the ack returned contains "OwnMind 已經是關閉狀態"

## Non-functional requirements

- **Zero external dependencies**: `session-off-state.js` is pure functions, no new packages introduced
- **Corrupted-file safeguard**: if state file parse fails → treat as invalidated, do not crash
- **Auto-create missing directory**: if `~/.ownmind/state/` does not exist, create it automatically (mkdir -p)
- **Fail safe**: all IO failures "fail open" (plain English: if it can't be written, treat as not-off and run lint normally)
