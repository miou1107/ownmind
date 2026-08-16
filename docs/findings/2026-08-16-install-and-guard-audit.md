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

**What a user hits:** the enforcement bundle is unreadable, so no path rule is enforced for
the rest of the session, and nothing anywhere says so. A protection that is off looks exactly
like a protection that ran and found nothing.

**Cause:** a bare `catch {}` in `hooks/ownmind-edit-reminder.js`.

**Fix:** it still fails open — a broken check must not stop somebody working — but it now
returns a notice saying the check did not happen and what repairs it.

### F4 — The Windows CI leg could not fail a build · verified

**What a user hits:** a defect that only breaks Windows ships, because every release reports
success. F2 did exactly that for three days.

**Cause:** `test-windows` was a separate job with `continue-on-error: true`. The comment in
the file said to fold it back into the matrix once Windows was clean; nothing made that
happen, and nothing failed while it did not.

**Fix:** `windows-latest / node 20` is now a leg of the `test` matrix, with a veto.

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

---

## Open — verified, not fixed

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

### O2 — A secret rule set to "do not block" prints a green tick over a leaked key · verified

Control: the rule set to block → the commit is stopped. Problem case: the same rule with
`block_on_fail: false`, or with the field absent → the commit proceeds and the terminal says
`Pre-commit check: all 1 rules passed ✓` while `AWS_ACCESS_KEY_ID=…` is in the staged diff.
The green tick is the defect; failing open may be arguable, claiming a pass is not.

### O3 — The secret scanner misses most real key shapes · verified, needs a decision

25 combinations of five key shapes against five ways of writing them: 8 blocked, 17 missed.
Indentation and quotes defeat it; an AWS secret-key shape is missed in all five forms.

**Not fixed on purpose.** `detectSecretLike` is shared with the memory-write API, whose
design prefers false negatives — widening it changes behaviour for a caller that wants the
current behaviour. This is a design change, so it is Vin's call, not a repair.

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
