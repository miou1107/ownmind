# v1.26.73 — One heartbeat row per machine, not per person

## The defect

`collector_heartbeat` was `UNIQUE (user_id, tool)`. A person has five slots however many
computers they own, and every scan overwrote the previous machine's `machine`,
`scanner_version`, `os` and `reason`.

Watched happen on production 2026-08-05. At 11:50 Vin's rows read `claude-code` on TANK
and the other four on Vincent.local. After a manual scan on the Windows box at 12:30 all
five read TANK, and the Mac's status was gone from the database with no record it had
ever reported.

**The cost is not cosmetic. A dead collector on one machine is invisible while another
machine of the same person is alive**, because the heartbeat is fresh and the usage is
flowing. 系統設定 shows only the last writer, so the second machine does not appear at all.

## Why now

v1.26.72's self-check can ask the server "did my data arrive", and on a two-machine
account the best answer it could give was *"the server records this against another
computer"*. That is a shrug, not an answer, and it is the last thing between the collector
and a diagnosis that does not need physical access to the machine.

It also blocks the environment and debug snapshot Vin asked for: two computers' diagnostics
overwriting each other is worse than collecting none.

## The change

`UNIQUE (user_id, tool, machine)`, and `machine` becomes `NOT NULL DEFAULT 'unknown'`
first — Postgres treats NULLs as distinct in a unique index, so a client that reports no
hostname would insert a fresh row on every heartbeat instead of conflicting with its own.

The `DO UPDATE` stops assigning `machine`. It is the conflict target now, and that one
assignment is precisely how two computers erased each other.

## What follows from it

- The self-check finds **its own** row among several for a tool, so `confirmed` means this
  machine rather than the account. A machine whose upload is failing can no longer read a
  sibling's fresh heartbeat as proof of its own success.
- `admin-clients.js` needed nothing: its roll-ups were already `some`/`every` over the
  client list, and they get more accurate.
- `team-overview.js` gets better for free. Its `LEFT JOIN LATERAL … ORDER BY
  last_reported_at DESC LIMIT 1` was written around this exact limitation, with a comment
  naming it and a "Future:" note.
- Three queries that render one version per tool now collapse with `DISTINCT ON`, newest
  machine wins. Without it every two-machine member appears twice.

## Not in this change

The 系統設定 panel will list a tool once per machine. The data carries the machine name so
they are tellable apart, but **how the panel should present two computers is a design
question and gets a mockup before any rendering changes** — the rule is that UI is agreed
before it is built, not after.
