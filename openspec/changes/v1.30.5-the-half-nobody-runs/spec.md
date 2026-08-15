# Spec — the platform that runs it is the platform that must be checked

## Requirement 1 — every platform's session start syncs the enforcement bundle

### Scenario: the hook a platform actually registers

- **GIVEN** the session-start hook registered on this platform
- **WHEN** it runs with reachable credentials
- **THEN** it MUST fetch the enforcement bundle
- **AND** write it to `~/.ownmind/cache/enforcement.json`

Windows registers the `.js` hook, macOS and Linux register the `.sh`. A sync placed in one is
absent from the other, and the absence has no symptom beyond a prompt line that reads like a
setting.

### Scenario: the server cannot be reached

- **THEN** the session MUST still start
- **AND** the cached copy, if any, MUST be kept

The bundle is not worth failing a session over. An empty fetch must never replace a populated
cache — one empty response once disarmed every rule at once, which is why that rule exists.

### Scenario: one definition

- **GIVEN** both hooks need this behaviour
- **THEN** both MUST call the same exported function

A second copy is precisely how these two drifted apart.

## Requirement 2 — a file URL is constructed, never concatenated

### Scenario: an entry-point check

- **GIVEN** a module deciding whether it is the process entry point
- **THEN** it MUST compare `import.meta.url` against `pathToFileURL(process.argv[1]).href`

### Scenario: the guard

- **GIVEN** any source file outside comments
- **WHEN** it builds a `file://` URL by concatenation or interpolation
- **THEN** the guard MUST fail, naming file and line

### Scenario: the guard states its premise per platform

- **WHEN** it runs on Windows
- **THEN** it MUST assert the concatenated and constructed forms differ
- **WHEN** it runs on POSIX
- **THEN** it MUST assert they agree

The POSIX half is the important one. There the mistake is invisible, and a rule whose reason
cannot be seen locally gets removed as noise.

### Scenario: comments

- **GIVEN** a comment showing the forbidden form
- **THEN** the guard MUST ignore it

Every corrected site names the wrong form so the next reader knows what not to write. A guard
that reads those as violations makes the explanation unwritable.

## Requirement 3 — a hook is tested the way its host runs it

### Scenario: spawning a hook that reads stdin

- **GIVEN** a test that spawns a hook reading stdin to EOF
- **THEN** it MUST send a payload and close stdin

Claude Code sends JSON and closes. A harness that opens the pipe and walks away is testing
something that never happens, and it fails at a timeout whose message describes the assertion
rather than the wait.

## Requirement 4 — a test that cannot run says so

### Scenario: a fixture the platform cannot provide

- **GIVEN** a test whose fixture requires `docker`, `ls` or `cat`
- **WHEN** it runs on Windows
- **THEN** it MUST skip, with a reason naming what is missing

A red that means "not applicable here" trains people to ignore reds.

### Scenario: an assertion the platform cannot satisfy

- **GIVEN** POSIX permission bits on Windows
- **THEN** the test MUST assert what the platform can guarantee
- **AND** state in the same place what it cannot

`gate.key` is not writable on Windows and is still readable by other accounts. Relaxing the
number without saying that would turn a known gap into a forgotten one.

## Out of scope

Closing the Windows ACL gap on `gate.key`. Making `tests/helpers/real-db.js` runnable on
Windows. Both are named here so the next person finds them named rather than absent.
