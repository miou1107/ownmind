# v1.26.106 — Spec

## Requirement: text written by PowerShell is decoded by its BOM, not by assumption

Any file this project reads that PowerShell may have written MUST be decoded according to
its byte-order mark, and MUST NOT be read as UTF-8 unconditionally.

Windows PowerShell 5.1's `Tee-Object` has no `-Encoding` parameter, so it always writes
UTF-16LE. Every PowerShell writing style leaves a BOM, which makes the BOM a reliable signal
where guessing is not.

### Scenario: a UTF-16LE register log

- **GIVEN** a `register-task-*.log` beginning `ff fe`
- **WHEN** self-check reads it for the diagnostic report
- **THEN** the decoded text is the log's actual content, containing no NUL bytes

### Scenario: a UTF-8 register log

- **GIVEN** a log written as UTF-8, with or without a BOM
- **WHEN** self-check reads it
- **THEN** the decoded text is unchanged, and a leading BOM is not part of it

## Requirement: no NUL reaches the uploaded report, in any encoding of itself

The serialized report MUST contain neither a raw NUL byte nor its JSON escape sequence.

Postgres rejects an entire JSONB document over one NUL; the INSERT fails and the client's
retry spool resends the same row indefinitely (v1.17.83). `JSON.stringify` converts a raw NUL
into an escape sequence, so a check that searches the serialized text for a raw NUL finds
nothing and reports success — while the escape sequence is exactly what Postgres objects to.

### Scenario: a report field carries a NUL

- **GIVEN** a report whose text fields contain NUL bytes
- **WHEN** it is serialized for upload or for the spool
- **THEN** the output contains no NUL and no `\u0000` escape sequence

### Scenario: upload and spool agree

- **GIVEN** the same report
- **WHEN** it is written to the spool and when it is uploaded, including when a failed entry
  is written back for a later retry
- **THEN** all of them go through the same serialization, so none can drift from the others

### Scenario: a value that literally contains the escape text

- **GIVEN** a report field whose text is the six characters of the escape sequence, as
  written in an install log
- **WHEN** the report is serialized
- **THEN** the text survives and the document still parses — stripping it there would eat one
  of the two backslashes `JSON.stringify` emitted and leave the other escaping the next
  character, which is the malformed document the server rejects and the spool retries

## Requirement: a check that timed out is reported as a timeout

When a spawned command is killed by the timeout, the recorded detail MUST say so.

`safeSpawn` returns `killed` and `signal`; a caller that keeps only `error` produces a
message indistinguishable from the command being absent, and the accompanying fix line then
tells the user to install what they already have.

### Scenario: `Get-ScheduledTask` exceeds its budget

- **GIVEN** the scheduler probe is killed by its timeout
- **WHEN** the failure is recorded
- **THEN** the detail identifies it as a timeout, including the signal, rather than reading
  as a missing command

## Requirement: the CIM budget is sized for the call it guards

The timeout for `Get-ScheduledTask` MUST account for PowerShell autoloading the
ScheduledTasks module and opening a CIM session, and for the check running immediately after
an install or upgrade.

Measured at ~1.5s on an idle Windows 10, against a 5s budget shared with `launchctl list`,
which takes about 20ms. The budget is now 30s.

### Scenario: a healthy scheduler under load

- **GIVEN** a machine whose scheduled task exists and is `Ready`
- **WHEN** self-check runs immediately after an upgrade
- **THEN** the scheduler check does not report a failure

## Requirement: every file resolves its own directory in a way that works on Windows

No file — test or shipping — MUST derive a filesystem path from `new URL(...).pathname`
without `fileURLToPath`.

On Windows that yields `/C:/Users/...`, which node joins onto the current drive root. On
macOS it happens to be a valid absolute path, so the defect is invisible there.

The guard covers `hooks/`, `mcp/`, `scripts/`, `shared/` and `src/` as well as `tests/`. Its
first version scanned tests only, on the reasoning that the defect it had just found lived
there — and it was live in a shipping hook at the same time. A guard that only looks where
the last bug was found will keep finding the last bug.

### Scenario: the suite polices itself

- **GIVEN** the test sources
- **WHEN** they are scanned
- **THEN** no test file contains a bare `.pathname` used as a path

### Scenario: a hook that fails quietly

- **GIVEN** a hook designed to exit 0 on any error, whose imports are relative to its own
  directory
- **WHEN** that directory is resolved by a bare `.pathname` on Windows
- **THEN** the import cannot resolve, the hook exits without running, and nothing is printed
  — so the guard must cover shipping code, where a wrong path produces silence rather than
  a failing test

## Requirement: a test that spawns PowerShell to run a script passes the policy flag

Any test that dot-sources or executes a `.ps1` MUST spawn PowerShell with
`-ExecutionPolicy Bypass`, matching every shipping caller.

A Windows client that has never set a policy defaults to Restricted, which blocks the
dot-source outright.

### Scenario: the guard picks the right subjects

- **GIVEN** a test that spawns PowerShell through a variable named for `pwsh`
- **WHEN** the guard selects files to inspect
- **THEN** it is inspected — matching is case-insensitive and covers both executable names,
  because the first version required a quoted lowercase `powershell` and therefore skipped a
  file that was violating this very requirement

### Scenario: the detector test actually runs the detector

- **GIVEN** a Windows client with no execution policy configured
- **WHEN** the Git Bash detection test runs
- **THEN** the detector executes and its verdict is what is asserted

### Scenario: a `.cmd` stub carrying cmd.exe metacharacters

- **GIVEN** a stub reproducing a real `bash --version`, whose third line ends
  `<http://gnu.org/licenses/gpl.html>`
- **WHEN** the stub runs under cmd.exe
- **THEN** the `<` is escaped rather than read as input redirection, and the detector sees
  the intended output

## Requirement: a test's premise must hold on every platform it runs on

### Scenario: an unstat-able path

- **GIVEN** a test needing a path that `stat` cannot read
- **WHEN** it constructs one
- **THEN** it does so by a means that works on NTFS as well — replacing the directory with a
  file, so `stat` fails with ENOTDIR — rather than `chmod(0o000)`, which is a no-op there

### Scenario: "cygpath is unavailable"

- **GIVEN** a test needing an environment without `cygpath`
- **WHEN** it constructs one
- **THEN** it empties `PATH` rather than setting `/usr/bin:/bin`, where Git Bash's cygpath
  lives

## Requirement: the Windows-only defects are asserted from any platform

The tests covering the above MUST NOT require a Windows machine to run.

These defects survived because every test that could reach them needed one. Encoding is a
property of bytes, so a byte fixture suffices; the rest are properties of the test sources,
so scanning them suffices.

### Scenario: running the new suites on macOS

- **GIVEN** a macOS checkout
- **WHEN** `tests/windows-log-encoding.test.js` and `tests/windows-test-hygiene.test.js` run
- **THEN** every case executes; none is skipped for want of Windows

## Known limits

- `windows-test-hygiene.test.js` scans sources textually. A path built by an
  indirection it cannot see would not be caught, and its case count grows with the number of
  test files rather than being fixed.
- The BOM rule identifies the encodings PowerShell produces. A file written by something
  else as UTF-16 without a BOM would still be misread; nothing in this project writes one.
