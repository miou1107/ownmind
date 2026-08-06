# v1.26.72 — Spec

## Requirement 1 — The server answers what it holds for the caller

### Scenario: an authenticated account asks

- **GIVEN** a request carrying a valid api key
- **WHEN** it calls `GET /api/usage/self-check`
- **THEN** it receives that account's `collector_heartbeat` rows plus a recent event
  count per tool, and the server's own clock

### Scenario: it is nobody else's data

- **THEN** the response is scoped to the authenticated `user_id` and takes no user
  parameter

A member must be able to run this. It is the check they run on their own machine, so it
cannot be admin-only, and it therefore must not be able to name anyone else.

### Scenario: the server's clock is in the response

- **THEN** `server_time` is returned

The client decides whether a heartbeat is recent. Doing that against the local clock
makes a machine with a wrong clock report a healthy collector as broken, or the reverse.

## Requirement 2 — The machine turns that into a verdict it can act on

### Scenario: the data arrived

- **GIVEN** this machine just scanned a tool and sent events
- **AND** the server's row for that tool names this machine and is within the freshness
  window
- **THEN** the verdict is `confirmed`

### Scenario: the machine has nothing to say about a tool it does not have

- **GIVEN** the scan reported `no_install` for a tool
- **THEN** the verdict is `not_installed` and it does not count as a failure

### Scenario: the server has no recent record from this machine

- **GIVEN** this machine scanned the tool and did not report `no_install`
- **AND** the server has no row for it, or a row older than the freshness window
- **THEN** the verdict is `not_recorded` and the check fails

This is the case the whole change exists for, and it is the one that used to be
indistinguishable from health.

### Scenario: the tool could not be read

- **GIVEN** the scan reported `unreadable` or `sqlite_missing`
- **THEN** the verdict is `blocked` and the check fails

The failure is on this machine, not in transit, and the message has to say so or the
person will go looking in the wrong place.

### Scenario: the row cannot say which computer wrote it

- **GIVEN** the server's row has no machine recorded
- **THEN** the verdict is `unattributed` and the check warns

Not `confirmed`. `collector_heartbeat` is UNIQUE (user_id, tool), so there is one row per
tool for the whole account, and a fresh row with no machine name is indistinguishable
from another computer's. Treating unknown as "this machine" lets a computer whose upload
is silently failing read its neighbour's heartbeat as proof of its own success — the one
outcome this change exists to prevent.

### Scenario: another computer owns the row

- **GIVEN** the server's row for that tool names a different machine
- **THEN** the verdict is `other_machine` and the check warns rather than fails

The events did reach the right account. What is lost is the ability to tell which
computer they came from, which is backlog 14. Reporting it as a failure would send
someone to debug a machine that is working.

### Scenario: freshness is measured against the server's clock

- **THEN** the window is applied to `server_time` minus `last_reported_at`, both from the
  response

## Requirement 3 — The verdict is legible to whoever ran the installer

### Scenario: what is printed

- **THEN** each tool gets one line, and a failure names the next thing to do

### Scenario: the exit code carries it

- **GIVEN** any tool verdict is a failure
- **THEN** the process exits non-zero

An installer that prints a problem and exits 0 has told the machine nothing, and the
scheduled runs above it read exit codes.

### Scenario: the check never breaks the install

- **GIVEN** the network is down, the server is unreachable, or the response is malformed
- **THEN** the check says so and the installer still completes

A diagnostic that can fail an installation is a worse defect than the one it detects.

## Requirement 4 — It runs where somebody will read it

### Scenario: at the end of an install or upgrade

- **THEN** both `install.sh` and `install.ps1` run it after the scanner is in place

### Scenario: on demand

- **THEN** the same entry point can be run by hand, so a person diagnosing a machine has
  one command rather than a procedure
