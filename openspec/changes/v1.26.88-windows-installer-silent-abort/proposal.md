# v1.26.88 — Proposal: the Windows upgrade path aborts halfway, silently

## Background

Bug report #15, filed 2026-08-06 by the `Vin-windows-test` account (machine `TANK`,
Windows 10 + Git Bash + Node 25.8.1), severity `critical`. Reproduced from a `bash -x`
trace on the reporting machine, not inferred.

Running `bash ~/.ownmind/scripts/bootstrap.sh` on Windows aborts inside `install.sh`
at the `node -e` block that writes the PreToolUse / WorktreeCreate hook entries. The
script prints nothing, `interactive-upgrade.sh` rolls back, and the log it tells the
user to read has already been deleted by that same rollback.

Everything after that point never runs:

- `ensure-session-hook.cjs` — the SessionStart hook, i.e. automatic memory loading
- `ensure-key-file.cjs` — background credentials repair
- the git hooks that enforce iron rules
- usage-scanner schedule registration
- the end-of-install self-check

### Three layers, each independently sufficient to hide the failure

**1. A POSIX path handed to a native Windows Node.**

Under Git Bash, `$HOME` expands to `/c/Users/Vin`. Paths passed as *arguments* are
converted by the MSYS runtime, so `node some-helper.cjs "$FILE"` works. Paths
*interpolated into the `-e` script source* are not converted — they arrive as
`/c/Users/Vin/.claude/settings.json`, and `node.exe` resolves a leading `/` against the
drive root, producing `C:\c\Users\Vin\.claude\settings.json` and `ENOENT`.

This exact failure was already diagnosed once. `scripts/install-helpers/path-helpers.sh`
exists, was added in v1.26.7 for Vin's 2026-05-26 report of the same thing, and uses
`cygpath -m` correctly. It was wired into `interactive-upgrade.sh` and into no other
script. `install.sh` and `update.sh` have carried fifteen unconverted interpolations
ever since.

**2. `2>/dev/null` on a `set -e` script.**

The failing block ends `" 2>/dev/null`. Node's stderr is discarded, `set -e` aborts, and
neither stdout nor stderr carries a single character. The observable symptom is a script
that stops.

**3. Rollback deletes the log it points you at.**

`LOG_FILE="${OWNMIND_DIR}/logs/upgrade-${TS}.log"`, and `rollback()` is
`rm -rf "${OWNMIND_DIR}"` followed by `mv "${BACKUP_DIR}" "${OWNMIND_DIR}"`. The message
`see ~/.ownmind/logs/upgrade-<TS>.log; backup restored` names a file that the same
function just destroyed. Measured on the reporting machine: 0 bytes.

### Why this went unnoticed for so long

The reporter notes that after the failed upgrade rolled back to v1.26.86, a separate
mechanism later pulled the working tree to v1.26.87. So `package.json` reports the new
version on a machine where no install step ran. **Version number is not evidence that
installation completed** — which is why the v1.26.87 broadcast telling Windows users
"upgrade and memory loading will come back" was not actionable: the upgrade could not
finish on Windows.

That machine's self-check nonetheless reports 11 passed, because it had previously been
installed with `install.ps1`, which is a separate, working implementation. The two
Windows paths disagree, and only the broken one is used for upgrades.

## Decisions

| question | decision |
|---|---|
| how to convert paths | source the existing `path-helpers.sh`; do not write a fourth copy |
| which sites | every path interpolated into `node -e` / `node -p` **source text**; argv paths are converted by MSYS and are left alone |
| what about `2>/dev/null` | stderr from installer `node -e` blocks goes to a log file, never to `/dev/null` |
| where the upgrade log lives | `~/.ownmind-logs/`, outside the directory rollback replaces |
| how to keep this from returning | a test that parses both scripts and fails on any unconverted path interpolation — the list is derived, not hand-written |
| detect a truncated install | after `install.sh` finishes, assert its critical artifacts exist and `fail` loudly if not |
| align `install.ps1` with `install.sh` | out of scope; recorded in the backlog |

## Scope

**In:** sourcing `path-helpers.sh` from `install.sh` and `scripts/update.sh`; converting
every interpolated path in both, plus the two beacon helpers in `update.sh` and
`interactive-upgrade.sh`; replacing `2>/dev/null` on installer `node -e` blocks with a
log destination; moving the upgrade log outside the rollback target; an end-of-install
artifact assertion; a derived-list guard test.

**Out:** reconciling `install.ps1` with `install.sh` (backlog). Rewriting the `node -e`
blocks as helper `.cjs` files (larger change, no additional coverage).

## Risks

- **`cygpath -m` on a path that is already Windows-form** is a no-op, and on Mac/Linux
  `cygpath` does not exist so `to_win_path` returns its input unchanged. The conversion
  is therefore provably inert off Windows, which is what keeps this low-risk for the
  platforms that currently work.
- **Un-suppressing stderr makes installs noisier.** Accepted: the alternative is the
  present situation, where a fatal error produces no output at all. Output goes to a log
  and only the failure summary reaches the terminal.
- **The guard test can only see what it can parse.** It fails closed: a `node -e` block
  whose extent it cannot determine is reported as a failure rather than skipped.
