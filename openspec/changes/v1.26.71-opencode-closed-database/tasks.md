# v1.26.71 — Tasks

Legend: `[ ]` pending · `[x]` done

One extracted module, one adapter changed, and a correction to the previous release's
spec. No server change, no schema change, no client change.

## Phase 0 — Measure before designing

- [x] Confirmed the second copy of the pattern is real and is the only one:
      `shared/scanners/opencode.js:201` was the single remaining hand-built
      `sqlite3 -readonly` invocation outside `vscode-telemetry.js`
- [x] Reproduced the failure on the real database. A copy of `opencode.db` in an empty
      directory fails `-readonly` and reads fine unflagged; `PRAGMA journal_mode` returns
      `wal`
- [x] **Caught the first measurement being contaminated by the measurement itself.**
      `-readonly` against the live file succeeded, which read as "OpenCode is fine". It
      succeeded because the `PRAGMA journal_mode` probe one line earlier had opened the
      database read-write and created the `-shm` sidecar `-readonly` needs. The directory
      listing taken *before* that probe shows no sidecars. Iron rule 770's shape with the
      sign flipped: not a zero mistaken for a finding, but a success manufactured by the
      instrument
- [x] Measured the cost before deciding whether to guard it: 13 MB, 24 ms, largest of the
      four databases on this machine. No guard added

## Phase 1 — RED

- [x] `tests/scanner-opencode-closed.test.js`, 10 tests, failing on a module that did not
      exist yet
- [x] Includes one test against the **real** sqlite3 CLI, driving the whole adapter, which
      is what proved the v1.26.70 design wrong before it shipped
- [x] That test asserts its own premise: it checks the direct `-readonly` read really does
      fail before claiming the fallback fixed anything, and skips loudly if a future
      sqlite3 stops failing there

## Phase 2 — GREEN

- [x] `shared/scanners/sqlite-cli.js` — `runSqliteCli`, `isCantOpen`, `JOURNAL_SIDECARS`,
      `DEFAULT_MAX_BUFFER`, moved out of `vscode-telemetry.js` unchanged apart from
      `maxBuffer` becoming a parameter and the log prefix becoming `[sqlite-cli]`
- [x] `vscode-telemetry.js` imports it, drops five now-unused imports, and re-exports it
      as `defaultRunSqlite` so existing callers and tests are untouched
- [x] `opencode.js` routes through it, keeps its 100 MB ceiling, and now passes its
      `logger` so a failed snapshot can say why
- [x] Temporary directory prefix `ownmind-vscdb-` → `ownmind-sqlite-`, since it is no
      longer only vscdb files

## Phase 3 — Verify

- [x] New file: 18 tests, 0 failures, 0 skipped. Both real-CLI tests **ran** rather than
      skipping; the snapshot one saw two invocations, the first with `-readonly` and the
      second without
- [x] Full suite: 2843 tests, 0 failures, 2 skipped (both pre-existing)
- [x] Before and after, on the real 13 MB `opencode.db` copied without its sidecars —
      the exact file `sqlite3 -json -readonly` refuses with `unable to open database
      file (14)`:

      before (HEAD)  events: 0    reason: none → orchestrator says `no_new_activity`
      after          events: 926  no warnings, nothing left beside the original

      Same bytes, same adapter entry point, one release apart.

## Phase 4 — Review

One round against a non-git copy outside the repo. Three findings, all three acted on,
one of them by measuring instead of coding.

- [x] **OpenCode reported `no_new_activity` when its database could not be read.** The
      reviewer's sharpest find and the one that mattered most: the adapter caught every
      failure into `{ events: [] }` with no `reason`, so the orchestrator derived one from
      an empty result and answered "he did not use OpenCode today". The exact
      false-healthy signal v1.26.69 was written to kill, still open for this adapter, and
      the reason this release's own fix could not have been observed working on a real
      machine. Now `unreadable` / `no_install` / `sqlite_missing`, with the same
      `exists(dbPath)` question v1.26.69 added for Cursor.
- [x] **The logger test proved nothing.** It injected `runSqlite`, so it never touched
      `defaultRunSqlite` — the wiring it claimed to check. Replaced with a real-CLI test
      driving adapter → defaultRunSqlite → runSqliteCli → the snapshot fallback, asserting
      a `[sqlite-cli]` warning reaches the adapter's logger.
- [x] **A cursor tie can skip a row permanently.** Real mechanism, wrong conclusion about
      its reach, and measuring settled it: zero same-millisecond pairs across 1205
      messages, and the id's time-derived prefix orders correctly across milliseconds.
      *Within* one millisecond the random suffix decides, so the hazard is genuine — and
      it predates this change, since a live read between two same-millisecond commits does
      the same thing. Named in the spec, recorded as backlog item 21, not fixed here: the
      fix changes Tier 1 ingestion semantics.
- [x] Found before the review, while re-reading my own diff: `{ maxBuffer: MAX_BUFFER,
      ...opts }` lets a caller passing `maxBuffer: undefined` land on the shared 10 MB
      default. Silent truncation on exactly the long first scan the 100 MB exists for.

## Phase 5 — Sync

- [x] `package.json` 1.26.71
- [x] `README.md`, `docs/README.ja.md`, `docs/README.zh-TW.md`
- [x] `CHANGELOG.md`
- [x] `FILELIST.md` — `sqlite-cli.js` added to the scanners tree
- [x] `openspec/BACKLOG.md` — item 20's follow-up closed, the Windows gap kept open with
      the cheapest proof named
- [x] `openspec/changes/v1.26.70-…/spec.md` and `proposal.md` — corrected from
      `immutable=1` / `pathToFileURL` to what actually shipped, and the sidecar
      requirement added as its own scenario
- [x] `openspec/changes/v1.26.70-…/tasks.md` — Phase 6 item ticked, Phase 7 added for the
      spec drift

## Phase 6 — Out of scope, recorded

- [ ] Nothing proves the fallback is reached on Windows. Carried forward from v1.26.70
      and now the only open half of backlog item 20.
