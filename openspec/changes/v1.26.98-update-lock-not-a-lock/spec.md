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

## Requirement: a stale lock is reclaimable, and reclaiming cannot produce two holders

A lock whose mtime is older than five minutes belongs to a run that died and MAY be
reclaimed.

Deleting a path and re-creating it CANNOT be made atomic on a plain filesystem: any process
that judged a file stale can end up removing a different file that has since taken the path.
`rename` does not solve it either — it moves the same decision one level down. The
requirement is therefore not atomicity but that **no two processes ever both believe they
hold the lock**, achieved in three parts, each of which MUST be present:

1. Deletion MUST be serialised behind its own exclusively-created file.
2. Whoever wins that MUST re-read the lock's age immediately before deleting.
3. An acquirer MUST write a value only it could have written, and read it back after
   creating. If what it reads is not what it wrote, the lock was displaced and it MUST NOT
   report success.

Clearing a reclaim marker left by a dead reclaimer is itself a delete-and-recreate and MUST
use the same discipline: move it aside under a name unique to the clearing process, and a
process that loses that move MUST NOT reclaim on that pass.

The five-minute threshold and all three parts MUST be the same in the shell and Node
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

- **GIVEN** a stale lock and a stale reclaim marker, and several processes reaching the
  acquire together
- **THEN** at most one of them ends up holding a lock

### Scenario: losing the move-aside

- **GIVEN** a stale reclaim marker, and the move-aside failing because another process got
  there first
- **THEN** this process reclaims nothing, deletes nothing, and does not acquire

### Scenario: the acquirer's lock is replaced

- **GIVEN** a process that created the lock, and a different value in the file by the time
  it reads back
- **THEN** it reports that it did not acquire

## Requirement: the lock files are not part of the working tree

`.update-lock`, its reclaim marker and any move-aside name MUST be ignored by git.

The user's `~/.ownmind` is a git checkout, and `scripts/interactive-upgrade.sh` reads a
non-empty `git status --porcelain` — which includes untracked files — as a dirty tree, and
answers it with `git reset --hard origin/main`. A lock file merely existing during an upgrade
would trigger that.

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
