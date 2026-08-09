# v1.26.106 — Proposal: four defects that only break on Windows, and that a Mac cannot see

## Background

This repository has no CI. `.github/` holds a `CODEOWNERS` file and nothing else, so tests
run only where somebody runs them — and a Windows-only path is either skipped on a Mac or
never reached at all.

**A test that is green on macOS is not a passing test to the person on macOS. It is an
invisible one.** All four defects below share that shape.

## 1. The diagnostic log uploaded to the server was mojibake carrying 148 NUL bytes

| | |
|---|---|
| written by | `install.ps1:626` `Tee-Object -FilePath $RegisterLogPath` |
| read by | `self-check.cjs:783` `readFileSync(path, { encoding: 'utf8' })` |

Windows PowerShell 5.1's `Tee-Object` has **no `-Encoding` parameter** — it was added in
PS 6 — so it always writes UTF-16LE.

Measured on the machine:

```
bytes on disk : 298
NUL count     : 148
read as utf8  : "\xff\xfe[\^@o\^@w\^@n\^@m\^@i\^@n\^@d\^@]\^@..."
actual content: "[ownmind] using node: C:\Program Files\nodejs\node.exe"
```

**Every** `register-task-*.log` on that machine begins `fffe`. The oldest is dated
2026-05-09.

This is the raw material of the v1.17.83 incident, which
`tests/install-check-null-byte-sanitize.test.js` documents at the top of the file: one NUL
anywhere makes Postgres reject the whole JSONB document, the INSERT fails, and the client's
retry spool resends the same row indefinitely. That was fixed by stripping on the server
before INSERT. This is the other half.

`self-check.cjs:844` was itself reporting `default_outfile_encoding: 'Unicode (UTF-16 LE
BOM)'` — in the field next to the one it was corrupting.

## 2. The scheduler check uploaded a fabricated FAIL

`self-check.cjs:678` used `TIMEOUT_MS = 5000`. `Get-ScheduledTask` is a CIM cmdlet:
PowerShell must autoload the ScheduledTasks module and open a CIM session before it answers.
Measured on an idle Windows 10:

```
run 1: 1494 ms   run 2: 1515 ms   run 3: 1462 ms   run 4: 1460 ms   run 5: 1457 ms
```

Three times the headroom — except self-check runs at the one moment the machine is busiest,
immediately after an install or upgrade. The 2026-08-09 upgrade hit it:

```json
{ "name": "scheduler", "status": "fail",
  "detail": "Get-ScheduledTask failed: Command failed: powershell.exe -NoProfile -Command Get-ScheduledTask ...\n",
  "fix": "Requires Windows + PowerShell" }
```

The same report carried `scheduler_detail` reading `state: Ready`, `last_task_result: 0x0`.
Lowering the timeout to 600ms reproduced the message character for character.

`launchctl list` takes about 20ms, so the same constant was 250× headroom on macOS. It was
never sized for this call.

Second layer: `safeSpawn` returns `killed=true, signal=SIGTERM`, and the caller kept only
`r.error`. So a timeout reached the user as "Requires Windows + PowerShell" — on a machine
that visibly has both.

## 3. Four test files were not testing anything on Windows

`new URL(...).pathname` yields `/C:/Users/...` on Windows, which node then joins onto the
current drive root:

| file | result on Windows |
|---|---|
| `install-artifacts.test.js:10` | `MODULE_NOT_FOUND: C:\C:\Users\...` — the process dies **before the first assertion** |
| `session-log-args.test.js:122` | ENOENT |
| `source-files-are-text.test.js:45,56` | ENOENT |
| `installer-node-paths.test.js:29,191` | ENOENT |

On macOS that same pathname happens to be a valid absolute path, so all four were green. The
eleven other sites already had an `import.meta.dirname ||` fallback and were fine.

The broken set includes the `install-artifacts` CLI test — the one `install.sh` calls to
decide whether an install finished.

## 4. The only test that actually runs the Git Bash detector could not pass anywhere

`git-bash-detection.test.js:225` spawned PowerShell with `['-NoProfile', '-Command', script]`
and no `-ExecutionPolicy Bypass`. A Windows client that has never set a policy defaults to
Restricted, which blocks dot-sourcing a `.ps1`. macOS has no PowerShell, so the whole
`describe` was skipped. Every shipping caller — `install.ps1`, `mcp/index.js`,
`ownmind-session-start.js` — passes that flag; only the test did not.

That decision point is which hook to register, bash or node — the same one behind the
v1.26.80 System32 WSL relay defect.

Fixing it exposed a second layer: the `.cmd` stub did not escape cmd.exe metacharacters, and
a real `bash --version` ends its third line with `<http://gnu.org/licenses/gpl.html>`. cmd
reads `<` as input redirection, writes a syntax error to stderr, and PowerShell turns that
into a NativeCommandError. Both Git Bash cases carried that line, so both were rejected and
the test accused a detector that was working — confirmed by running `Test-IsGitBash` against
a hand-written stub, which returned `True`.

Same shape as the unescaped `)` in `start.cmd` fixed in v1.26.100.

## Two more tests that failed only on Windows

- `install-artifacts.test.js` used `chmod(0o000)` to produce an unstat-able path. That is a
  no-op on NTFS. It now replaces the directory with a file so `stat` fails with ENOTDIR — a
  reason every platform agrees on, which also removes the special case for running as root.
- `installer-node-paths.test.js` used `PATH=/usr/bin:/bin` to mean "no cygpath". Git Bash's
  cygpath lives in `/usr/bin`, so the premise was false on Windows and a correct conversion
  was scored as a failure. The PATH is now emptied, which makes the premise true everywhere.

## What this changes

- New `scripts/install-helpers/read-text-file.cjs` — decodes by BOM rather than by
  assumption, since every PowerShell writing style leaves one. Also `stripNul` and
  `stripNulEscapes`.
- `install.ps1` writes the register log through `Write-Utf8NoBom`; the screen output
  `Tee-Object` also provided is restored with `Write-Host`, and `$LASTEXITCODE` is read on
  the very next line.
- `self-check.cjs` — reads that log by BOM, raises the CIM budget to 30s, adds
  `describeSpawnFailure()` so a timeout is reported as a timeout, and routes both upload and
  spool through a single `serializeReport()`.
- The four `pathname` sites become `fileURLToPath()`.
- The Git Bash test passes `-ExecutionPolicy Bypass` and escapes its `.cmd` stub.

## Impact

Every Windows install: the register log has been unreadable since at least 2026-05-09, and
the scheduler check can report a healthy scheduler as failed at the busiest moment of an
upgrade — which is what produced the health-broadcast warning on 2026-08-09.
