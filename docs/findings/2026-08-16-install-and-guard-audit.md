# Findings — 2026-08-16 install and path-guard audit

What was found while making the Windows CI leg blocking and writing a clean-install test.
Each entry says what breaks for a user, how it was proved, and where it stands.

**Evidence rule for this document:** an entry is `verified` only if it was reproduced by
running something. `reported` means an agent or a bug report claimed it and nobody has
re-run it yet — those are listed separately at the bottom and must not be quoted as facts.

---

## Fixed in v1.30.8

### F1 — The path guard allowed any first file in a new folder · verified

**What a user hits:** the assistant is told a colleague owns `ci/**`. It writes
`ci/templates/projects.yml`, a path with no `ci/templates/` directory yet — the folder is
created by the same write. The guard allows it. Adding a file under a guarded path is the
exact thing the guarantee is about.

**Cause:** `resolveRepo` ran `git -C <dirname(file)>`. A directory that does not exist yet
makes git error, the error was read as "this file is in no repository", and the guard
returned `null`, which means allow.

**Proof:** `findGuardViolation` returned `null` for `ci/templates/brand-new.yml` in a repo
whose `origin` matched the guard, and a violation for `ci/projects.yml` in the same repo.

**Fix:** `resolveRepo` climbs to the nearest existing ancestor and adds the missing segments
back. Regression test: *a file whose directory does not exist yet is still caught*.

### F2 — The path guard allowed the edit whenever two spellings of one directory disagreed · verified

**What a user hits:** on Windows, the guard does not block anything it should. This is what
kept the Windows CI leg red on every run from 2026-08-13 to 2026-08-16.

**Cause:** `relPath` was `path.relative(root, file)`. `os.tmpdir()` answers
`C:\Users\RUNNER~1\…` while git answers `C:\Users\runneradmin\…`; both open the same
directory and `fs.realpathSync` reconciles neither. The subtraction produced a path climbing
out of the repo, so the file read as belonging to somebody else's repository and was allowed.
Any case difference on a case-insensitive volume does the same.

**Proof:** the CI log's own assertion output —
`expected: 'C:\Users\RUNNER~1\AppData\Local\Temp\om-guard-…'` against
`actual: 'C:\Users\runneradmin\AppData\Local\Temp\om-guard-…'`. Reproduced on macOS through
case, which is the same shape. After the fix the 11 failures are gone from the Windows leg.

**Fix:** `relPath` comes from git's own `--show-prefix`, computed from the directory git is
standing in, so no path string is subtracted from another.

### F3 — A guard that could not run said nothing · verified

**What a user hits:** the cache holding the path rules is corrupt or unreadable, so no path
rule is enforced for the rest of the session, and nothing anywhere says so. A protection that
is off looks exactly like a protection that ran and found nothing.

**Cause:** a bare `catch {}` in `hooks/ownmind-edit-reminder.js`.

**The first fix did not cover the case it named.** Replacing the bare `catch` with a notice
only helps if something throws, and nothing does: `readEnforcementBundle` catches every read
and parse error and answers with an empty bundle, so a corrupt cache arrives as `guards: []`
— indistinguishable from an account with nothing annotated. Caught in review, with the
measurement: corrupt file and missing file both return
`{selectors:[],guards:[],injectables:[],present:false}`. The test written alongside the first
fix passed, because it constructed a malformed guard *object* rather than a malformed file.

**Fix:** branch on the `present` flag the bundle already carries. `present: false` with a
cache file on disk is "could not be read" and is reported; no cache file at all is a machine
that has not synced yet, which is an ordinary first run and stays quiet. The notice is
appended to the hourly listing rather than returned instead of it — returning early stopped
the listing too, and put an unthrottled message in front of every single edit.

Both halves have a red-green check: with the `present` branch removed, *a cache file that
cannot be read is reported* fails.

### F4 — The Windows CI leg could not fail a build · verified

**What a user hits:** a defect that only breaks Windows ships, because every release reports
success. F2 did exactly that for three days.

**Cause:** `test-windows` was a separate job with `continue-on-error: true`. The comment in
the file said to fold it back into the matrix once Windows was clean; nothing made that
happen, and nothing failed while it did not.

**Fix:** `windows-latest / node 20` is now a leg of the `test` matrix, with a veto. Verified
on run 31933887945: `windows-latest / node 20` success, and the clean-install job green on
all three platforms.

### F5 — Database tests failed instead of skipping on Windows · verified

**What this cost:** six false failures on every Windows run, which is part of why the leg
stayed red and easy to ignore.

**Cause:** `tests/helpers/real-db.js` gated on `docker info` succeeding. The GitHub Windows
runner has a daemon in Windows-container mode: `docker info` answers fine, and `docker run`
of a Linux image then throws. A throw is not the `null` that means "skip loudly".

**Fix:** the probe reads `docker info --format '{{.OSType}}'` and returns `null` on a
positive non-Linux answer. An older docker that does not support `--format` still falls
through to `docker run`, so a Linux machine can never be skipped by mistake.

### F6 — Nothing ran the installer · verified

**What a user hits:** a machine reports "the tool is not registered in the file Claude Code
reads" while the whole suite is green.

**Proof:** 356 test files; 26 name `install.sh`; none execute it. The hits that look like
executions are sample command strings inside rule-classification tests.

**Fix:** `tests/install-clean-machine.e2e.mjs` runs the real installer into a throwaway home
and then asks each feature whether it works — the MCP is spawned and asked for its tools, the
registered edit hook is fed a guarded edit, the installed git hook is run against a staged
key. A new CI job runs it on Linux, macOS and Windows.
`tests/install-e2e-is-actually-run.test.js` fails if that job stops naming the file.

**Deliberately not covered, and why:** the GitHub clone (it would test origin/main and
GitHub's availability, not the branch) and the live scheduler registration (`launchctl load`
and `systemctl --user enable` register with the login session, not with `$HOME`, and a test
must not do that to the machine running it).

### F7 — The clean-install job would have been red on every pull request · verified in review

Found by review before it shipped, and worth recording because the shape is nasty: green on
`push` and `workflow_dispatch`, red on `pull_request`, so `main` stays green while every PR
fails — including the PR adding the job, where the tempting fix is to mark it non-blocking.
That is precisely the pattern F4 exists to end.

**Two causes, and the second was only found by the PR itself.**

1. `actions/checkout@v4` leaves a `pull_request` build on a detached HEAD with **no local
   branch**. The test seeded `~/.ownmind` by cloning that checkout; a clone of a branchless
   detached repo is itself detached, and `install.sh`'s existing-directory branch runs
   `git pull`, which exits 1 with "you are not currently on a branch".
2. The first fix — push the commit under test into a throwaway bare repo and clone from
   that — then failed for a different reason nobody had looked for: `checkout@v4` also
   fetches depth 1, and pushing a shallow history into a fresh repository is refused with
   `! [remote rejected] HEAD -> main (shallow update not allowed)`.

**Proof:** cause 1 took two attempts to reproduce — the first fixture kept a local `main`
alongside the detached HEAD and `git clone` picked it up, so it passed. Cause 2 was found by
opening the PR, which is exactly the failure mode being fixed: green on `push` and
`workflow_dispatch`, red only on `pull_request`.

**Fix:** the seed carries no history from the checkout at all. The tracked files are copied
out of the **working tree** into a fresh one-commit repository, and `~/.ownmind` is cloned
from that. `git pull` then runs for real and finds nothing, so the installer's update path
stays exercised; nothing is written to the checkout under test; and because it is the working
tree rather than `HEAD`, running the file locally now tests the edit just made rather than
the last commit.

**And the lesson that made it stop recurring:** a developer's own working copy cannot produce
either condition, so both were invisible until CI said so. `scripts/sim-pr-checkout.sh`
builds a checkout that is shallow *and* branchless and runs the test inside it — that is where
the third attempt was verified, before pushing rather than after.

### F8 — The throwaway home was not actually sealed · verified in review

Two ways a test run could have reached the developer's real machine:

- `preflightMcp`'s `home` option chooses which file the registration is *read* from; the
  child is spawned with `{...process.env, ...entry.env}`, so `HOME` arrived from the
  developer's shell. The MCP server resolves `~/.ownmind` from that and fires its
  auto-update, which can `git pull` and `npm install` in the real install.
- `install.sh` runs `git config --global`. With `XDG_CONFIG_HOME` set and the throwaway
  `$HOME/.gitconfig` absent, git writes to `$XDG_CONFIG_HOME/git/config` instead — and the
  test then deletes the directory that config points at, leaving `core.hooksPath` aimed at
  nothing and git hooks silently off in every repository on that machine.

**Fix:** one `sandboxEnv()` used by every spawn in the file, carrying `HOME`, `USERPROFILE`,
`XDG_CONFIG_HOME` and `GIT_CONFIG_GLOBAL`, and the preflight entry is passed in with that env
rather than left to inherit. A new assertion fails if `core.hooksPath` ends up outside the
throwaway home.

**Postscript, because it is the same lesson twice in one afternoon.** That new assertion was
written as `hooksPath.startsWith(world.home)` and promptly failed on Windows against
`C:/Users/RUNNER~1/…/.ownmind/git-hooks` — a path plainly inside the home. git answers with
forward slashes; `world.home` carries backslashes. One directory, two spellings, compared as
strings, wrong answer: F2 exactly, written an hour after fixing F2. The comparison normalises
separators now and is case-insensitive where the filesystem is.

**Proved to go red, not just to go green.** A check only ever seen passing is a check nobody
has evidence about. Two defects were committed on purpose — the guard returning `null`
always, and the MCP registration silently doing nothing, which is the failure a real Windows
machine reports today. Against that build the file went 6 pass / 3 fail, and the three were
exactly *the tool is registered in the file Claude Code actually reads*, *the registered tool
actually starts and answers*, and *the registered edit hook really blocks an edit to somebody
else's path*. The deliberate commit was dropped immediately afterwards.

The same argument applies to the daily check's alert, so
`.github/workflows/daily-install-check.yml` takes a `drill` input that fails the install on
purpose. Running it with `drill` on should produce a GitHub issue; that is how the alerting
path gets exercised without waiting for a real outage.

**The drill has not been run yet, and neither has the daily check.** GitHub resolves both
`schedule` and `workflow_dispatch` against the *default branch* only: until this lands on
`main`, `gh workflow run daily-install-check.yml` answers `HTTP 404: workflow ... not found
on the default branch`, and no schedule fires. So the alert path is written and syntax-checked
and nothing more. **First thing to do after merging: run it once with `drill` on, confirm an
issue appears, and close that issue.** Until that has happened, treat the daily check as
unproven — which is the same standard everything else in this document was held to.

---

## Fixed in v1.30.9

### O6 — The gate blocks without its message reaching the user · verified 2026-08-16

Releasing v1.30.8 was correctly stopped by guard 820 ("releases and deploys are asked about
first"). What the user saw was nothing. What the assistant saw was
`Hook PreToolUse:Bash denied this tool` — no rule name, no reason, and no sign that a
one-word answer would clear it.

`hooks/locales/zh.json` has the right sentence ready and waiting:

> 🟢 AI 想做一件你規定要先問過的事，OwnMind 先擋住了：{title}
>   你回「go」，OwnMind 就放行這一次；回「no」就不准。

It did not appear. The assistant only learned what the gate wanted by reading
`action-gate.js` and the locale file directly — which a user cannot do, and which no
assistant should have to.

**Why this one matters more than its size.** A block nobody can see is a block nobody can
release, so the next person to hit it either gives up or goes looking for a way around — and
the way around is `gate-ask-<session>-<guard>.json`, which is O1. The silent block is what
makes the self-unlock tempting rather than merely possible. Fixing the message is therefore
part of fixing O1, not separate from it.

Not investigated yet: whether the envelope is dropped by this harness, by the `.sh`, or by
the CLI. That is the first question.

**Fixed.** Every PreToolUse block now sends `hookSpecificOutput.permissionDecision: 'deny'`
with `permissionDecisionReason` alongside the legacy `decision`/`reason` pair. Measured in
the live harness both ways: with the old envelope the same block arrived as
`Hook PreToolUse:Bash denied this tool`; with the new one the whole reason came through,
including the sentence telling the assistant to relay it.

It was not only the gate. Three other emitters had the same shape, and two of them put their
entire message in `additionalContext`, which is not read on a deny — so the version-tag block
arrived with no version number in it, and a blocked edit could not name the standard it hit.
`formatGuardBlock` also gained the "tell the user this" line its sibling warning always had.

`tests/hook-deny-envelope.test.js` runs all four emitters and holds them to one shape; each
one was broken in turn to confirm it goes red alone.

### O1 — The assistant can approve its own gate · verified 2026-08-15

Driven through the registered hook, not the module: blocked, blocked, the assistant writes
`gate-ask-<session>-<guard>.json` containing `{"approved":true}`, allowed — and the hook says
nothing about having been unlocked. The audit row records `approval_mode: verbal`.

In code mode the six-digit consent code is recoverable from the stored fingerprint by trying
all 900,000 values: measured 318ms and 32ms on two runs. `MAX_ASK_MISSES = 5` does not apply,
because recovering the code costs no wrong guesses. The signing key at
`~/.ownmind/state/gate.key` is mode 400 and owned by the same uid the assistant runs as, so
signing the file is available too.

**Scope, measured:** 3 blocking guards against 313 rules the reply check can reach, on the
one account that has any. Everyone else has zero. This is a hole in a small surface.

**Fixed, with one part honestly left open.**

- The code is no longer recoverable. `scrypt` with a per-record salt replaces the bare
  sha256: measured 0.7 s for the full 900,000-value sweep before, 16.8 hours after, at 67 ms
  per verification. Memory-hard at 32 MB per attempt, so parallel hardware does not collapse
  it. A code-mode ask also expires after an hour, which keeps the window far inside that.
- The record is sealed with `gate.key`, and the seal covers the approval state, the session
  and the guard — so a hand-written `{"approved":true}`, a flipped flag on a genuine record,
  and a seal lifted from another guard all fail. A record in the previous format is refused
  rather than upgraded.
- **Not closed:** `gate.key` is readable by the same uid, so an assistant determined to forge
  one can still read it and compute the hmac. This turns a one-line file write into
  deliberate key theft; it is a speed bump, not a wall, and is documented as such in the code.
- A verbal ask has no secret at all, by design, so nothing can verify it. The allow it grants
  now says so — "the AI said you agreed to X" — which is the only check that a claim of
  consent can ever have. A record with a bad seal is ignored, logged as `forged_approval`,
  and reported to the user rather than passed over in silence.

**The first version of that seal did not hold, and review found it.** Recorded here in full,
because the paragraph above is what the release notes said while all four of these worked:

| Attack | Why it worked |
|---|---|
| Plant a `mode:'verbal'` record on a code-mode guard, then run the documented `--verbal` approve command | `approveActionVerbal` read `mode` off the attacker's own record |
| Plant a record with your own `codeSalt`/`codeHash`, then approve with your own code | `approveAction` never checked the seal, then wrote the record back **through** the sealing helper — a signing oracle |
| Keep the genuine record and its genuine seal, swap only `codeSalt`/`codeHash` | those two fields were outside the sealed set |
| Reset `misses` on a burned ask | so was `misses`, so `MAX_ASK_MISSES` was a suggestion |

None of them reads `gate.key`; three are silent. Fixed by verifying the seal before any other
field is read, extending the sealed set to `v, mode, kind, approved, approval_mode, issuedAt,
codeSalt, codeHash, misses`, signing a canonical JSON array rather than a `:`-joined string,
and requiring the record's mode to match the guard's configured mode at consume time.

Two more from the same review, both about what the user is told rather than what is allowed:
a forgery detected on any guard that was not the one blocking was thrown away (single slot,
read only inside the ask branch), and "the key or nonce is unreadable" was reported with the
same sentence as "somebody forged this" — an accusation, over a genuine approval, because a
file was missing.

`tests/gate-self-approval.test.js`: 18 tests. 8 fail against the pre-review gate; the TTL test
was separately mutation-checked, because it had been passing on a stale seal rather than on
the clock.

### O2 — A secret rule set to "do not block" prints a green tick over a leaked key · verified

Control: the rule set to block → the commit is stopped. Problem case: the same rule with
`block_on_fail: false`, or with the field absent → the commit proceeds and the terminal says
`Pre-commit check: all 1 rules passed ✓` while `AWS_ACCESS_KEY_ID=…` is in the staged diff.
The green tick is the defect; failing open may be arguable, claiming a pass is not.

**Fixed, and it was two faults, not one.** The green tick was the visible one: a rule that
failed but is not set to block left no trace anywhere and was counted among the rules
reported as passed. It now names the rule, says OwnMind let the commit through on purpose,
and says which setting to change.

The one underneath was worse. A secret-guard rule stood the baseline scan down as soon as it
*looked* at the hits, whether or not it did anything about them — so a rule set to
`block_on_fail: false` removed the floor and then declined to block itself. The baseline
exists so that no rule setting can leave a leak unguarded; only a rule that actually stops
the commit stands it down now.

`tests/pre-commit-secret-baseline.test.js` gained five tests; three fail against the
pre-change hook, two are controls.

---

## Open — verified, not fixed


### O3 — The secret scanner misses most real key shapes · verified, needs a decision

25 combinations of five key shapes against five ways of writing them: 8 blocked, 17 missed.
Indentation and quotes defeat it; an AWS secret-key shape is missed in all five forms.

**Not fixed on purpose.** `detectSecretLike` is shared with the memory-write API, whose
design prefers false negatives — widening it changes behaviour for a caller that wants the
current behaviour. This is a design change, so it is Vin's call, not a repair.


### O5 — A symlink inside a repo pointing outside it escapes the path guard · verified

`repo/ci -> /somewhere-else` with a guard on `ci/**`: writing `repo/ci/projects.yml` is
allowed.

Measured mechanism, which is not the one first proposed: git chases the link before it
answers, so it is standing in the link's *destination*. When that destination is in no
repository, `resolveRepo` returns `null` — "this file is in no repository" — and the guard
allows the write. Pointed at a different repository instead, the file would be attributed to
that one and judged against its remote.

Pre-existing; the old code did the same, so it is not a regression from v1.30.8. Same class
as O1: the guard covers the ordinary route and not a deliberate one.

### O4 — The reply check has been failing much more often recently · verified, cause unknown

Not "broken": across `check_id` 777–982 there are 206 checks and 10 recorded failures. But
the recent window 968–982 is 8 failures out of 15. The failure log records only failures, so
it cannot be read as a total on its own. Cause not yet investigated.

---

## Reported, not re-run — do not quote as fact

These came from audit agents earlier in the same session and have not been reproduced by
hand. Each needs its own check before it is acted on.

| Claim | What would settle it |
|---|---|
| `/api/memory/hook-context?trigger=commit` returned 404 336 times in 14 days | Query the access log for that path and status directly |
| `ownmind_search` swallows a connection failure and answers "nothing found" | Point the MCP at a dead URL and read what the tool returns |
| Parallel subagents share one `session_id`, so gate state collides | Run two agents at once and compare the session ids in the gate log |
