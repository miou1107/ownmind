# v1.26.68 — Tasks

Legend: `[ ]` pending · `[x]` done

One new module, one new parameter on the shared adapter, one wiring change. No server
change, no schema change, no migration, no installer change.

## Phase 0 — Measure before designing

- [x] Established that Antigravity runs three surfaces, not two: the manager (2.5.0),
      the editor (2.1.1) and the CLI, all live on this machine
- [x] Confirmed no OwnMind MCP process runs under either Antigravity application (every
      one is a child of Claude or ChatGPT), so nothing was going to arrive by that route
- [x] Found the conversation stores under `~/.gemini/<surface>/conversations/` and
      counted them by mtime: 114 / 108 / 1489 files, 17 distinct days in union
- [x] Confirmed the 22:35 manager conversation is
      `~/.gemini/antigravity/conversations/df8d3160-….db`, mtime 22:37, so the earlier
      "the manager writes nothing locally" conclusion was measured in the wrong tree
- [x] Counted file extensions before deciding what to match: 13 `.db` + 100 `.pb` in the
      manager, 501 `.db` + 494 `.db-wal` in the CLI. An extension filter would have gone
      quiet at the next format change.
- [x] Confirmed `~/.gemini/antigravity-backup/` holds 101 conversation files, which is
      why the surface list is written out rather than globbed

## Phase 1 — RED

- [x] `tests/scanner-antigravity-conversations.test.js`
- [x] Ran against a stub returning `[]` / `null`: **14 failed, 10 passed**
- [x] Audited the 10 passes rather than accepting the failure count. Four asserted
      nothing against a stub that does nothing:
  - [x] "does not include the migration backup directory" — vacuous over an empty list
  - [x] "uses one home-relative layout" — same
  - [x] "returns null when the surface has no conversations yet" — indistinguishable
        from a function that always returns null; rewritten to require a real answer
        from a second, populated surface
  - [x] "wires the real conversation directories" — asserted only `adapter.tool`;
        rewritten to build a real `~/.gemini` layout in a temp home and require the date
        to come back through the production construction path
- [x] Re-ran: **18 failed, 6 passed**. The remaining six are boundary cases and
      regression guards for behaviour this change must *not* alter; none can fail before
      the change, and that is recorded rather than hidden.

## Phase 2 — GREEN

- [x] `shared/scanners/gemini-conversations.js`
- [x] `shared/scanners/vscode-telemetry.js`: `extraDateSources`, folded in through the
      same `consider()` that applies the future-date ceiling
- [x] `shared/scanners/antigravity.js`: wires the conversation source on every
      construction path, including the explicit `dbPath` one
- [x] 23/25, then a real defect surfaced by the last two:

**The ceiling was in the wrong place.** `newestConversationMtime` returned the maximum
mtime and the adapter judged it afterwards, so one file with a rolled-forward clock hid
every believable date in the same directory. This is v1.26.66's "a blind max lets a dead
directory win" wearing new clothes, and the test caught it because the fixture put a
good file next to the bad one instead of testing the bad file alone.

- [x] Added a module-level test naming the offending file in the warning, watched both
      fail, moved the ceiling per-file into `newestConversationMtime`
- [x] `FUTURE_TOLERANCE_MS` exported so there is one constant, not two
- [x] 25/25

## Phase 3 — Hermeticity

The new default reads the real home directory, which is right in production and wrong in
a test.

- [x] `tests/scanner-vscode-multipath.test.js` — one test was asserting the developer's
      own Antigravity usage and failed loudly. Pinned with `conversationDirs: []`.
- [x] `tests/scanner-cursor-antigravity.test.js` — same exposure, but it *passed* either
      way, which is the more dangerous kind. Pinned too.
- [x] Grepped every construction site to be sure those were the only two

## Phase 4 — Verify

- [x] Full suite: 2779 tests, 0 failures, 2 skipped (the known v1.26.65 chmod guards)
- [x] Against the real machine, isolating the new source:

| what | result |
|---|---|
| manager `state.vscdb` only, as before | `2026-05-18` |
| manager `state.vscdb` + conversation stores | `2026-08-05` |
| warnings on a healthy machine | none |
| cursor ahead at 2026-08-06 | still re-emits 2026-08-05 |
| cursor already at 2026-08-05 | emits nothing |

- [x] End to end: scanner run with the other four adapters skipped, cursor advanced
      `2026-05-18` → `2026-08-05`, log line `sessions=1`, POST accepted
- [x] Server: `session_count` holds `(user 1, antigravity, 2026-08-05)`

## Phase 5 — Sync

- [x] `package.json` 1.26.68 (`SERVER_VERSION` reads it, so no second edit)
- [x] `README.md`, `docs/README.ja.md`, `docs/README.zh-TW.md`
- [x] `CHANGELOG.md`
- [x] `FILELIST.md`
- [x] `openspec/BACKLOG.md` — item 18 corrected and narrowed

## Phase 6 — Review

One round against a non-git copy outside the repo. Seven findings, three acted on.

**Accepted — a real defect, and it is v1.26.66's, not this change's.**

- [x] `currentSessionDate ?? lastSessionDate` picks the current one whenever it exists,
      and only *then* does the ceiling judge it. A database holding a future
      `currentSessionDate` beside a perfectly good `lastSessionDate` therefore
      contributed nothing at all: one wrong clock silenced that telemetry permanently,
      which is the exact outcome the ceiling was added to prevent. Wrote the failing
      test first, watched it return `undefined`, then offered both dates to the same
      maximum. Safe because there is no precedence left to get wrong.

**Accepted — the guards were weaker than they claimed.**

- [x] The privacy guard stripped only whole comment lines, so inline comments survived,
      and `/\bfsp?\.open\b/` missed a destructured `open`. Replaced the blocklist's
      weakest half with an allowlist: the only `fs` members the module may name are
      `readdir` and `stat`, and a destructured `fs` import is rejected outright. A
      blocklist only knows the ways to read a file that someone already thought of.
- [x] "Cursor reads nothing else" was asserted through a sqlite spy, which proves the
      spy was called correctly and nothing more. Added a structural guard that
      `cursor.js` imports neither the new module nor `extraDateSources`.

**Rejected — with reasons.**

- [x] *"The cursor moves backwards if today's conversation file is deleted."* Correct
      mechanically, and deliberate. v1.26.66 Requirement 6 chose `!==` over `>` so the
      cursor is self-healing; the server upserts `session_count` with `GREATEST`, so the
      re-emit costs one redundant write of a day that genuinely happened. Requiring the
      date to advance would permanently suppress every day beneath a cursor that got
      ahead, which is a far worse failure.
- [x] *"TOCTOU with SQLite checkpoints drops the newest date."* The race is real; the
      consequence is not. Losing a checkpoint's mtime yields a slightly older mtime,
      almost always the same calendar day, on a signal whose resolution *is* the day.
      The next scan corrects it thirty minutes later.
- [x] *"1489 sequential stats stall the event loop."* Measured rather than argued:
      **25ms for all three surfaces, ~1700 files**, three runs. Twice an hour.
      `Promise.all` over an unbounded file list would trade that for descriptor
      exhaustion on the machines with the most conversations.
- [x] *"Symlinked conversations are skipped."* True, already recorded in Phase 7. No
      measured surface uses one; `conversations/` held only UUID-named regular files on
      every install checked. Supporting it speculatively means a code path no fixture
      reflects.

- [x] Full suite re-run after the review fixes

## Phase 7 — Out of scope, recorded rather than done

- [ ] **Historical backfill.** The adapter reports only the freshest day, so the ten days
      already missing between 2026-05-18 and today stay missing. The mtimes could supply
      them, but only as a lower bound: a conversation worked on across twenty days shows
      one mtime. Changing Tier 2 to emit a range is a different change.
- [ ] **No MCP config for Antigravity.** `install.sh` writes a rules file only, so no
      heartbeat and no `user_tool_last_seen` ever fire. The path is now confirmed three
      ways and recorded in the backlog.
- [ ] **Naming.** `vscode-telemetry.js` now hosts a source that is not VSCode telemetry.
      Renaming it churns a file twice in three versions; recorded instead.
- [ ] **Symlinked conversation files** are skipped, because the filter is `isFile()`.
      Not observed on any measured machine.
