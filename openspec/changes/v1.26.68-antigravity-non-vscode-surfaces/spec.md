# v1.26.68 — Spec

## Requirement 1 — The conversation store of every known Antigravity surface is a session-date source

`geminiConversationDirs(homeDir)` returns the conversation directory of each surface.

### Scenario: the three surfaces

- **GIVEN** a home directory
- **THEN** the result is `~/.gemini/antigravity/conversations`,
  `~/.gemini/antigravity-ide/conversations` and
  `~/.gemini/antigravity-cli/conversations`

### Scenario: no per-OS prefix

- **THEN** the paths are the same shape on every platform

Unlike `state.vscdb`, which lives under `Library/Application Support` on macOS,
`.config` on Linux and `AppData/Roaming` on Windows, `~/.gemini` is a home-directory
dotfile tree on all three.

### Scenario: a migration leftover is not a surface

- **GIVEN** `~/.gemini/antigravity-backup/`, which exists on the measured machine and
  holds 101 conversation files from the 2026-05-20 migration
- **THEN** it is not in the list

The list is written out, not globbed. `antigravity*` would match the backup, and a dead
directory that wins a max comparison is the exact failure v1.26.66 exists to prevent.

## Requirement 2 — The newest conversation is found without reading any conversation

`newestConversationMtime({ dirs })` returns the newest mtime across the directories, or
null.

### Scenario: freshest across surfaces wins

- **GIVEN** the manager's newest file is 2026-08-05 and the editor's is 2026-07-30
- **THEN** the result is the 2026-08-05 timestamp

### Scenario: file format is irrelevant

- **GIVEN** a directory holding `.pb`, `.db`, `.db-wal` and `.tmp` files
- **THEN** all of them are considered

Measured: the manager holds 13 `.db` and 100 `.pb`, the CLI holds 501 `.db` and 494
`.db-wal`. The product has already changed conversation format once. Filtering by
extension would make the collector go quiet on the next change, in the same silent way
the directory rename did.

### Scenario: directories are not conversations

- **GIVEN** a subdirectory whose mtime is newer than every file
- **THEN** it is not counted

### Scenario: content is never read

- **THEN** the module contains no call that opens a conversation file

Conversation files hold the user's conversations. The collector's business is *when*,
never *what*. A test asserts this against the source, because a future edit that adds a
read would otherwise pass every behavioural test.

## Requirement 3 — Absent, unreadable and empty are three different things

### Scenario: a surface that is not installed

- **GIVEN** a directory that does not exist
- **THEN** it is skipped and nothing is logged

Most machines have one surface. A warning that fires on every healthy machine is a
warning nobody reads.

### Scenario: a surface that exists but cannot be read

- **GIVEN** a directory that raises `EACCES`
- **THEN** a warning is logged and the remaining directories are still read

Only `ENOENT` means "not installed". Same rule as `defaultExists` in v1.26.66: a
permission wall is an unanswered question, not a negative answer.

### Scenario: an installed surface with no conversations yet

- **GIVEN** an empty directory
- **THEN** the result is null and nothing is logged

### Scenario: one unreadable entry inside a readable directory

- **GIVEN** a directory where one entry cannot be stat'd
- **THEN** the other entries still produce a result

## Requirement 4 — The freshest of every source wins, under one ceiling

### Scenario: a conversation newer than the telemetry

- **GIVEN** `state.vscdb` reporting 2026-05-18 and a conversation file from 2026-08-05
- **WHEN** the adapter runs
- **THEN** it emits a session for 2026-08-05

This is the measured state of Vin's machine.

### Scenario: telemetry newer than any conversation

- **GIVEN** `state.vscdb` reporting 2026-08-05 and conversations ending 2026-07-30
- **THEN** it emits a session for 2026-08-05

Adding a source must not be able to move the answer backwards.

### Scenario: a conversation file dated in the future

- **GIVEN** a conversation file whose mtime is a year ahead
- **THEN** it is ignored and a warning names it

The v1.26.66 ceiling applies to every source, not only to `state.vscdb`. Without this a
single bad mtime is emitted once, the cursor advances past every real date, and the tool
goes silent permanently.

### Scenario: an extra source that throws

- **GIVEN** a date source that raises
- **THEN** the adapter still returns the telemetry answer and still sends a heartbeat

### Scenario: the cursor stays self-healing

- **GIVEN** a cursor already at 2026-08-06 and a freshest source date of 2026-08-05
- **THEN** a session for 2026-08-05 is still emitted

Unchanged from v1.26.66 Requirement 6: the comparison is `!==`, not `>`. The server
upserts with `GREATEST`, so a re-emit is idempotent, while requiring the date to advance
would permanently suppress every day beneath a cursor that got ahead.

## Requirement 5 — Only Antigravity gains the new source

### Scenario: Cursor is untouched

- **GIVEN** the cursor adapter
- **THEN** it reads `state.vscdb` and nothing else

### Scenario: an explicit dbPath still means that file

- **GIVEN** a caller passing `dbPath`
- **THEN** that file is read directly, and the conversation source is still consulted

`dbPath` asserts which database to read. It does not assert that the database is the
only thing in the world.
