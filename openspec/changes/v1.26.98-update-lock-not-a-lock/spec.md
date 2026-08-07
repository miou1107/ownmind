# v1.26.98 — Spec

## Requirement: acquiring the update lock is atomic

A program that is about to run the daily self-update MUST take `~/.ownmind/.update-lock` by
creating it exclusively — `O_CREAT|O_EXCL` — and MUST treat failure to create as "somebody
else holds it".

Testing for the file's absence and creating it as a separate step is forbidden, and so is
any create that succeeds on an existing file (`touch`, `>` without noclobber,
`openSync(f, 'w')`).

This applies to all three programs that share the file: the MCP, the Node SessionStart hook
and the shell SessionStart hook.

### Scenario: several hooks start at once

- **GIVEN** no lock file, and eight processes reaching the acquire together
- **WHEN** each tries to take it
- **THEN** exactly one succeeds and seven are told the lock is held

### Scenario: the lock is held

- **GIVEN** a lock file created moments ago
- **WHEN** another process tries to acquire
- **THEN** it fails, and the existing lock is left untouched

## Requirement: a stale lock is reclaimable, but only by one process at a time

A lock whose mtime is older than five minutes belongs to a run that died and MAY be
reclaimed. Deletion MUST be serialised behind its own exclusive file, and whoever wins it
MUST re-read the lock's age immediately before deleting.

Both the five-minute threshold and the serialisation MUST be the same in the shell and Node
implementations. A shorter threshold on one side would let it steal from a run on the other
that is still working.

### Scenario: several processes find the same dead lock

- **GIVEN** a lock file older than five minutes, and eight processes reaching the acquire
  together
- **THEN** exactly one of them ends up holding a lock

### Scenario: another process is mid-reclaim

- **GIVEN** a stale lock, and the reclaim marker present
- **WHEN** a process reaches the acquire
- **THEN** it does not delete the lock and does not acquire

### Scenario: the lock stopped being stale while waiting for a turn

- **GIVEN** a process that judged the lock stale, and a fresh lock in its place by the time
  it gets to delete
- **THEN** it deletes nothing and fails its own acquire

### Scenario: a reclaim marker left by a dead reclaimer

- **GIVEN** a reclaim marker older than five minutes
- **THEN** it is removed, and reclaiming can proceed — the re-read above is what makes this
  safe

## Requirement: losing the race is not a failure

A program that cannot take the lock MUST record `update_skipped` with reason `lock_held`.
It MUST NOT record `update_failed`.

`update_failed` MUST remain reserved for a step that was attempted and did not work, so that
a count of failures in the activity log is a count of things that went wrong.

### Scenario: three hooks lose the race

- **GIVEN** four hooks starting together and one winner
- **THEN** the log holds one `update_check` and three `update_skipped`, and no
  `update_failed`

## Requirement: the lock is taken before the attempt is announced

`update_check` MUST be logged only by the process that holds the lock.

Logging it before acquiring is what made a four-way stampede visible in the activity log as
four checks in the same second, and is the reason the underlying race was mistaken for
repeated upgrade failures.

### Scenario: four hooks, one lock

- **THEN** exactly one `update_check` appears

## Requirement: a lock is released only by the process that holds it

A program MUST NOT delete the lock in an error path it can reach without having acquired it.

Where the work continues in a detached child that outlives the acquiring process, the lock
MAY be left for the staleness sweep to reclaim; where nothing was started, it MUST be
released immediately.

### Scenario: the update script is missing

- **GIVEN** the Node hook acquired the lock and finds no `update.sh` / `update.ps1`
- **THEN** it releases the lock rather than holding it for five minutes over a no-op
