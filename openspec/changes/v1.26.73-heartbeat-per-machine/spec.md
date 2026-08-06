# v1.26.73 — Spec

## Requirement 1 — A machine's status is its own

### Scenario: two computers, one account, one tool

- **GIVEN** the same person runs `claude-code` on two machines
- **THEN** `collector_heartbeat` holds one row per machine and neither overwrites the other

### Scenario: a client that cannot say which machine it is

- **GIVEN** a heartbeat with no `machine`
- **THEN** it is stored under a definite value, never NULL

Postgres treats NULLs as distinct in a unique index. Left NULL, such a client would insert
a brand new row on every heartbeat, forever.

### Scenario: the key is not rewritten by an update

- **THEN** the `DO UPDATE` does not assign `machine`

It is the conflict target. That assignment is exactly how two computers erased each other.

### Scenario: the rate limit still applies

- **THEN** a second heartbeat from the same machine within the window is still suppressed

## Requirement 2 — The self-check answers about this machine

### Scenario: several rows come back for one tool

- **GIVEN** the server returns rows for this tool from more than one machine
- **THEN** the verdict is computed from **this machine's** row, whichever order they arrive in

### Scenario: this machine's row is stale and a sibling's is fresh

- **THEN** the verdict is `not_recorded`

The sibling's freshness is not evidence about this computer. Picking by tool alone would
have reported `confirmed` for a machine that is not reaching the server at all — which is
the failure this whole line of work exists to remove.

### Scenario: only another machine has a row

- **THEN** the verdict is `other_machine`, as before

## Requirement 3 — Readers that render one version per tool still do

### Scenario: a member with two computers

- **GIVEN** any query that projects `scanner_version` out of `collector_heartbeat`
- **THEN** it collapses to one row per (user, tool), newest machine first

The version somebody is effectively on is the one their most recently active machine
reports. An `EXISTS` probe asking "is this person instrumented at all" is exempt: it is
right to ignore machines.

### Scenario: aggregate status is unchanged

- **THEN** `installed`, `any_active` and `needs_upgrade` are still true if any machine
  says so

They were already `some`/`every` over the client list. They get more accurate, not
different.
