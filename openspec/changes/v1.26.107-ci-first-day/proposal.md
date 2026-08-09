# v1.26.107 — Proposal: CI, and what it found on day one

## Background

`.github/` held a `CODEOWNERS` file and nothing else. Tests ran only where somebody ran
them, which in practice was one macOS machine.

**On a Mac, a test that only breaks on Windows is not a failing test. It is an invisible
one.** Every defect in v1.26.106 survived on exactly that.

## What this adds

`.github/workflows/test.yml`, on push to `main`, on every pull request, and manually.

| | |
|---|---|
| gating job `test` | ubuntu × node 20, ubuntu × node 24, macOS × node 20 |
| reporting job `test-windows` | windows × node 20, `continue-on-error` |
| steps | `npm ci` → `node scripts/ensure-console-build.js` → `npm test` |
| database | not needed |

node 20 is the version in the Dockerfile; node 24 is the development machine's.

Windows does not gate yet: the first run had 109 pre-existing failures. Users pull updates
straight from `main`, so **merging is shipping**, and those failures cannot hold a release
hostage. When they are cleared, drop `continue-on-error` and fold it back into the matrix.

It is a separate job rather than a `continue-on-error` matrix leg, and that was measured, not
assumed: such a leg still reports `failure` in `needs.<job>.result`, so a gate reading that
value cannot distinguish "only Windows is red" from "everything is red". Two jobs make the
distinction structural.

## What it caught immediately

### `install-failed-beacon-ps1` had never passed anywhere

The harness extracted `function Fail` alone. `Fail` interpolates
`$(Get-LastLogLines $LogFile)`, defined further down the same file and not carried across, so
PowerShell threw a CommandNotFoundException while building the arguments — before reaching
the `Report-Error` call the test exists to verify — and `Fail`'s own `catch { }` swallowed
it. The record file was never written, and the failure surfaced as an ENOENT under
`os.tmpdir()` that named nothing.

It extracts dependencies recursively now, so the next dependency comes with it rather than
the test being hollowed out again.

Nobody noticed because it looked only for `pwsh`: macOS has no PowerShell, and Windows calls
it `powershell` — 5.1, which is what `install.ps1` actually invokes. Skipped on both, **and a
skip is indistinguishable from a pass in the summary.**

The old assertion `r.status === 1` could not separate "Fail threw and its catch handled it"
from "the script fell over"; both are 1. The catch now exits 3 and records the thrown
message, so the throw is verified rather than assumed.

### Two `scanner-schedule-repair` cases only ran on macOS

They called `plutil`, which is macOS-only; everywhere else it is ENOENT. Before CI, "macOS:
…" meant "nowhere". Both assertions are about a generated XML file and hold on any platform,
so they check it directly; `plutil` still runs as a cross-check where it exists, because it
is launchd's own parser and a hand-written check has no standing to replace it.

Windows then exposed a second problem: the expected value was built with `path.join` while
the path inside the plist was written by a bash helper. Git Bash calls the same directory
`/tmp/…` and node calls it `C:\Users\…\Temp\…` — two correct spellings of one directory,
compared as if the difference were a defect. It now compares what is actually under test:
that `{HOME}` was substituted, and that an `&` in a directory name survived `sed`.

### A product bug on Linux — the mirror image of the Windows ones

`hooks/ownmind-session-start.sh`:

```sh
mtime=$(stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null)
```

`stat -f` means "format string" on BSD and `--file-system` on GNU. On Linux that first call
prints a five-line filesystem report to **stdout** and only then exits non-zero, because `%m`
is not a valid operand — so `||` runs the GNU form and appends the correct epoch underneath.
`mtime` becomes the report, a newline, and the right number; the caller's arithmetic dies
with `syntax error in expression`.

Reproduced in an alpine container: `stat -f %m` exits 1 after printing `File: … Inodes: …`.

The comment on the line above already named the difference between the two platforms. The
code below it assumed one of them would fail **quietly**, and the two `2>/dev/null` only ever
covered stderr.

Both forms are now tried separately and the result is checked for digits, so it does not
matter which one pollutes stdout.

## The common shape

Three of these are one disease with different tool names — `pwsh`, `plutil`, and a `stat`
that behaves differently per platform. A test written as "run this only if X is present" does
not exist on a machine without X, and the summary does not say so.

CI's value here is not one more machine running the tests. It is that skipping became
visible.

## What CI still cannot catch

GitHub's Windows runner ships Git Bash and a looser execution policy than a normal client.
Anything of the form "the user's own security settings block the script" will not appear
here; that still depends on the self-check reports. Stated up front so CI is not mistaken for
insurance.
