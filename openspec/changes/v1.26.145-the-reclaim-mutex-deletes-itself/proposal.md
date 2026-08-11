# v1.26.145 — the thing guarding the door gets deleted by the people outside

## Why

Three programs share `~/.ownmind/.update-lock` so that only one of them runs `git pull`,
`npm install` and `update.sh` in that directory at a time. A lock older than ten minutes is
assumed to belong to a run that died, and is reclaimed. Because deleting a path and
re-creating it cannot be made atomic, the reclaim is serialised behind a second file,
`.update-lock.reclaim` — a mutex for the one section where deletion happens.

CI caught two processes inside that section (`ubuntu-latest / node 20`, run 31491011959, on
PR #87 — a change that does not touch any of this code). A re-run of the same commit passed,
so it is load-dependent.

Reproduced on 2026-08-11: sixteen contenders against a leaked marker, under twelve
CPU-saturating background processes. **56 double acquisitions in 500 rounds.** With tracing:

```
17460 ENTER reclaim section
17530 moved a fresh marker -> stand down    <- deleted 17460's LIVE marker
17516 ENTER reclaim section                 <- nothing left to stop it
17460 RM   17516 RM   17572 created/verify  <- 17572 holds the lock
17460 created/verify                        <- and so does 17460
```

**Clearing a leaked marker is itself a delete-and-recreate, so it can land on a marker that
is alive.** v1.26.111 saw half of this and made the process that moved a live marker stand
down. That keeps *that* process out. It does nothing about the marker, which has already
been deleted — and the marker is the mutex, so its owner is now inside an unguarded section
and the next arrival joins it. Each occupant then deletes the lock on the strength of an age
it read before somebody else's fresh lock existed.

The shared comment in `shared/update-lock.js` described the residual as "a process displaced
in the few microseconds after its own check". Measured, it is 11% of rounds under load, and
the cause is not microseconds — it is three processes in a section built for one.

## What changes

**The marker gets an owner, exactly as the lock already has one.** It is created carrying a
token, and its holder proves the marker is still its own immediately before it deletes
anything — both the stale lock and, on the way out, the marker itself.

That closes the loop at the level where it broke. An occupant that has lost its marker is
not an occupant, and stops acting like one. An occupant that has been replaced does not
delete its replacement's marker on the way out.

Both implementations change together (IR-022): `acquire_update_lock` in
`hooks/ownmind-session-start.sh` and `reclaimIfStale` in `shared/update-lock.js`.

### Two things that were tried and measured worse

- **Putting the marker back** after discovering it was live: 45 double acquisitions in 120
  rounds, against the bug's own 5. A restore is a second window in which the mutex is
  absent, and `rename` clobbers whatever took the path meanwhile.
- **Taking the lock out of the path before measuring it**, so only the measured file can be
  deleted: 53 in 120. It makes a live lock briefly absent on every reclaim attempt, which is
  an invitation rather than a guard.

Both are recorded in the code, because the shape of each is the obvious next idea.

## What this does not do

It does not make the reclaim atomic, and nothing available here can. Between the moment a
process establishes that it still owns the marker and the moment it unlinks the lock there
is an interval the scheduler can preempt; another process can destroy that marker, a third
can take the lock, and the first can wake and delete a lock it no longer has any right to.
Both ownership checks are placed as the last thing before their deletion so that interval is
as short as the language allows. That is a narrowing, not a closure.

Saying so is the point. The comment being replaced described its own residual as "a few
microseconds after its own check", and that sentence is why nobody re-measured for four
releases while the real figure was 11% of rounds under load.

## Impact

- No double acquisition in 500 rounds of the scenario that produced 56 in 500 before.
- What is left is rounds where nobody reclaims (3 in 400). That costs one skipped update,
  which the next session or the two-hourly scanner picks up. It is the safe direction.
- The ordinary case — a stale lock, no leaked marker — still yields exactly one winner in
  every round measured.
- No server, database or API change.
