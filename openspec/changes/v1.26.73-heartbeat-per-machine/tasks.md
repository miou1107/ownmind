# v1.26.73 — Tasks

Legend: `[ ]` pending · `[x]` done

## Phase 0 — Find every consumer before touching the key

- [x] Nine files read or write `collector_heartbeat`. Each one checked against "what
      happens when a tool comes back twice":
      - `events.js` — the writer, changed
      - `admin-clients.js` — `some`/`every` roll-ups, correct already, gets more accurate
      - `self-check.js` — changed to order deterministically
      - `team-overview.js` — **already written for this**, with a comment naming the
        limitation and a "Future:" note. Improves for free.
      - `team-stats.js` — stopped counting from this table in v1.26.58. Unaffected.
      - `me-narrative.js` — one `EXISTS` (fine) and one version list (changed)
      - `me.js` — two version lists (changed)

## Phase 1 — RED

- [x] `tests/heartbeat-per-machine.test.js`, 13 tests, covering the migration, the write,
      the self-check's row selection, and the readers that assumed one row per tool

## Phase 2 — GREEN

- [x] `db/019_collector_heartbeat_per_machine.sql` — backfill NULL, `SET NOT NULL`, swap
      the uniqueness. Idempotent.
- [x] `events.js` — three-column conflict target, `normaliseMachine`, and `machine` no
      longer assigned in the `DO UPDATE`
- [x] `selfcheck.js` — prefer this machine's row, fall back to another machine's so
      `other_machine` still reports rather than degrading to "never heard of it"
- [x] `me.js` ×2 and `me-narrative.js` — `DISTINCT ON`, newest machine wins
- [x] `observed-users.js` — the machine name rides along and identical entries dedupe

## Phase 3 — Verify

- [x] Full suite
- [x] Two mistakes of my own, both caught by tests rather than by reading:
      - a backtick inside a SQL comment closed the surrounding template literal
      - the new test posted without `express.json()`, so the route 400'd and no heartbeat
        was written — the assertion said "the heartbeat must have been written" and meant it
- [x] `tests/heartbeat-rate-limit.test.js` named the two key columns literally, so a test
      about the rate limit failed over a change to the key. Relaxed to `([^)]*)`, with the
      key itself now asserted by the new file.

## Phase 4 — Review

One round against a non-git copy outside the repo. Four findings: two fixed, one recorded,
one wrong and worth saying why.

- [x] **A client-supplied string is in the key now, so a client can make the table grow.**
      The sharpest one. Before this change the key had no client-controlled component and
      no account could add rows; now a machine whose hostname changes on every boot inserts
      one each time, and the per-row rate limit cannot help because every one is a first
      insert. Capped at 20 machines per (user, tool), in the same statement so there is no
      extra round trip on the ingest path — and the cap bounds **new** machines only, so
      hitting it never silences a computer that is genuinely reporting.
- [x] **The migration weakened the table before it verified it.** It dropped the old
      constraint and then built the new index. Reordered: build the new index while the old
      constraint still holds, so a collision fails the whole transaction instead of leaving
      the table with no uniqueness at all.
- [x] **Two computers with the same hostname are one machine.** Real, and narrower than
      what it replaces: before this change *all* of a person's computers shared one row.
      `shared/device-fingerprint.js` already generates a stable per-device id, so the fix
      exists — it just needs a column, a client change and a story for old rows. Backlog 22.
- [x] **"Existing rows might collide after the NULL backfill" — they cannot.** The old
      `UNIQUE (user_id, tool)` means there is exactly one row per pair, so whatever the
      backfill writes, no pair can produce two. The reordering above makes the database
      prove it rather than the comment claim it.
- [x] **`CREATE UNIQUE INDEX` takes a ShareLock and blocks writes.** True in general and
      not worth acting on here: the table holds one row per (person, tool), 45 of them on
      this server. `CONCURRENTLY` cannot run in a transaction and leaves an INVALID index
      on failure. Written into the migration so the next person sees the reasoning and the
      threshold at which it stops holding.
- [x] **A reaper deleting by (user_id, tool) would wipe every machine.** Checked: there is
      no DELETE or UPDATE against this table anywhere outside the migration.

## Phase 5 — Sync

- [x] `package.json` 1.26.73, `README.md` ×3
- [x] `CHANGELOG.md`, `FILELIST.md`, `openspec/BACKLOG.md` item 14 closed, item 22 added

## Phase 6 — The panel, after the mockup

Three options were drawn and Vin picked **A, grouped by machine**, on 2026-08-06.

- [x] `client/src/pages/System/machine-groups.js` — pure grouping, 13 tests. A machine's
      status is its **worst** tool's, not an average: one dead collector on an otherwise
      busy computer is the case this whole change exists to make visible. Its heartbeat is
      the freshest, because that is when the computer last spoke. Worst first in the list,
      because somebody reading this column is looking for what is broken.
- [x] `SystemConfigPage.jsx` renders it. The old `key={c.tool}` would have collided the
      moment a person had two computers.
- [x] `admin-clients.js` selects and returns `h.os` — the header says "TANK" and needed to
      say what kind of computer that is.
- [x] Three locale files together, per the rule that they never drift.
- [ ] The environment and debug snapshot, which this change was the prerequisite for.
