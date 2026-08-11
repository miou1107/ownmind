# Spec — the reclaim marker has an owner

## MODIFIED Requirements

### Requirement: only one process may be inside the reclaim section

The file that serialises stale-lock reclamation SHALL identify the process that created it,
and its holder SHALL verify that identity immediately before any deletion.

#### Scenario: the marker is taken away while its owner is inside

- **GIVEN** a process has entered the reclaim section and read the lock's age as stale
- **AND** another process deletes the marker, having mistaken it for a leaked one
- **AND** a third process then takes the lock
- **WHEN** the first process reaches the point where it would delete the stale lock
- **THEN** it finds the marker is no longer its own
- **AND** it deletes nothing
- **AND** it does not acquire the lock

#### Scenario: the marker has been replaced by another occupant's

- **GIVEN** a process is leaving the reclaim section
- **AND** the marker at that path now carries a different owner's token
- **WHEN** it removes the marker
- **THEN** it does not — the marker belongs to whoever is inside now

#### Scenario: an undisturbed reclaim

- **GIVEN** a lock left behind by a run that died, and no interference
- **WHEN** a process reclaims it
- **THEN** the stale lock is deleted, the marker is removed, and the process acquires

#### Scenario: contention on a leaked marker

- **GIVEN** both the lock and the marker have been left behind by dead runs
- **WHEN** sixteen processes contend under CPU saturation
- **THEN** no round admits two, across 500 measured rounds — a narrowing of the window,
  not a guarantee that none exists (see the proposal)
- **AND** rounds in which none acquires are permitted: the lock stays stale and the next
  session or scheduled scan reclaims it

### Requirement: both implementations of the protocol carry the same guard

The shell hook and the shared Node module SHALL implement identical rules, since a guard
present in only one is a protocol whose two halves disagree about who holds the lock.

#### Scenario: the guard exists on both sides

- **GIVEN** `hooks/ownmind-session-start.sh` and `shared/update-lock.js`
- **WHEN** either reclaims a stale lock
- **THEN** both write a token into the marker and verify it before deleting the lock
- **AND** both verify it before removing the marker

### Requirement: the concurrency harness cannot silently measure nothing

Tests that lift shell functions out of the hook SHALL derive the set of functions from the
code, not from a list written by hand.

#### Scenario: a helper is added to the protocol

- **GIVEN** `acquire_update_lock` gains a call to a new function in the same file
- **WHEN** the concurrency tests run
- **THEN** that function is lifted with it
- **AND** the tests do not report "no contender acquired" caused by `command not found`
