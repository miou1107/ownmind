# Tasks

## 1. Notice the line

- [x] During a Windows update, read `Usage scanner schedule: OK:schedule:skipped_unsupported_os`
      printed directly under `[ OK ] Usage scanner ready`
- [x] Confirm the Windows scheduled task exists and is Ready, so nothing was actually broken —
      the reporting was
- [x] Read the script's own header and find that it was written for a Windows machine, and
      never wired to Windows

## 2. Delegate

- [x] `msys*|cygwin*|mingw*|win32*` branch calling `ensure-scanner-schedule.ps1`
- [x] `cygpath` for the path, because PowerShell cannot open `/c/...`
- [x] stderr folded into the captured output and kept, not discarded
- [x] Contract line extracted, CR stripped, exit code passed through
- [x] No contract line → fail, quoting up to 200 characters of what the helper said
- [x] `OWNMIND_PWSH` as a test seam

## 3. Test

- [x] `tests/scanner-schedule-windows-delegation.test.js`, six cases, driven by a stub
      interpreter rather than by deleting the developer's scheduled task
- [x] Checked against the previous commit: **five of the six fail**
- [x] Verified live on this machine: `OK:schedule:already_registered`, exit 0
- [x] Verified an unrelated platform still reports `skipped_unsupported_os`

## 4. Verify

- [x] Full suite on Windows, temp folder counted before and after

## Two things the run turned up on the way

**The repo's own guard caught the first version of this branch.**
`tests/installer-node-paths.test.js` requires every `_WIN` variable to come from
`to_win_path`, and the first cut called `cygpath -w` by hand. Worth recording because the guard
did its job in the shape this project keeps asking for: it named the file and the line, and the
rule it enforces turns out to matter — `to_win_path` uses `cygpath -m`, and `-w` and `-m`
disagree about slash direction.

**Two unrelated tests went red under load and pass in isolation.**
`iron-rule-trigger-parity` and `reset-admin-password-script`, both with reported durations of
about nine hours, which is the runner's way of saying a timeout was hit. The parity test takes
55 seconds on its own — it spawns the shell classifier once per case — so under a loaded
parallel run it exceeds the 300s test timeout. A slow test that fails only when the machine is
busy is a false red, and a false red that lands on a different file each run is exactly the
thing this project spent v1.26.158 removing. Not fixed here; named so the next person does not
diagnose the classifier.

## A note on what was not done

The repair path itself was not exercised end to end on this machine, because doing so means
deleting a live scheduled task. `tests/windows-scanner-schedule.test.js` covers the helper; this
release covers the road to it. Said plainly rather than implied by silence.
