# v1.26.70 — Tasks

Legend: `[ ]` pending · `[x]` done

One function, `defaultRunSqlite`. No server change, no schema change, no client change.

## Phase 0 — Measure before designing

- [x] Reproduced the failure as a controlled test rather than an observation: the same
      bytes copied into an empty directory fail `-readonly` and read fine as
      `immutable=1`, while the live file succeeds under `-readonly` whenever the editor
      is running and a `-shm` sidecar exists
- [x] Corrected the earlier reading of this. `currentSessionDate = 2026-06-02` plus a
      matching file mtime had been written down as "Cursor usage has been missing since
      June". Vin opened Cursor, both went current, and the scan reported
      `sessions=1 reason=ok`. June 2 was the last day he had used it. A zero taken as a
      finding with no positive control; his using the app was the control.

## Phase 1 — RED

- [x] `tests/sqlite-readonly-fallback.test.js`, 10 tests, all failing
- [x] Included one test against the **real** sqlite3 CLI and a real database, which is
      what caught the first design being wrong

## Phase 2 — GREEN, and two design corrections that came from measuring

- [x] First implementation: copy the file, retry `-readonly` on the copy. **Wrong.** The
      copy fails identically, because what `-readonly` wants is the `-shm` sidecar and a
      bare copy has none. The real-CLI test failed and said so.
- [x] Second: read the copy as `file://…?immutable=1`. Correct for the sidecar problem,
      and then a measurement undercut it: these databases are in WAL mode and the live
      file really does carry a `state.vscdb-wal`. Copying only the main file drops
      whatever has not been checkpointed, which is exactly the most recent activity a
      scan is looking for, and `immutable=1` ignores the WAL by design.
- [x] Final: copy the database **and its journal sidecars**, then open the copy with no
      flags at all. SQLite owns the snapshot, so it may create what it needs and replay
      the WAL, and everything it writes goes away with the temporary directory. The live
      file is only ever opened `-readonly`.
- [x] `pathToFileURL` and `immutableUri` removed with the approach that needed them

## Phase 3 — Verify

- [x] Full suite: 2825 tests, 0 failures, 2 skipped
- [x] Against the real CLI and the real database, sidecar-less:
      `[{"key":"telemetry.currentSessionDate","value":"Wed, 05 Aug 2026 17:10:43 GMT"}]`
- [x] The real-CLI test asserts the fallback actually ran (two invocations, the first
      with `-readonly` and the second without), so it cannot pass without exercising it

## Phase 4 — Review

One round against a non-git copy outside the repo. Five findings, four acted on.

- [x] **WAL sidecar not copied.** Already fixed minutes earlier by measuring; the
      reviewer arrived at the same defect independently, which is the useful kind of
      agreement.
- [x] **The error-detection regex matched the path.** `err.message` from execFile starts
      with the whole command line, so a database under a directory named
      "unable to open database file" would send every ordinary failure down the
      fallback. Now stderr is preferred, and there is a test with exactly that directory.
- [x] **A genuine fallback failure was masked.** Any error at all was swallowed and the
      original `cannot open` rethrown, so a full disk or a permission wall on the temp
      directory read as a locked database. Now only ENOENT rethrows the original, which
      it must: an fs ENOENT raised from here would be read one level up as "the sqlite3
      CLI is missing".
- [x] **The real-CLI test could pass without entering the fallback** on a machine where
      the direct read happens to work. It now counts invocations and skips loudly rather
      than passing quietly.
- [x] **Torn copies** — accepted, not fixed. `fs.copyFile` is not atomic against a
      writer, but this path only runs when the editor appears closed, and a torn
      snapshot fails to parse, which is already handled as `unreadable`. Recorded in the
      spec rather than defended against.

## Phase 5 — Sync

- [x] `package.json` 1.26.70
- [x] `README.md`, `docs/README.ja.md`, `docs/README.zh-TW.md`
- [x] `CHANGELOG.md`
- [x] `FILELIST.md`
- [x] `openspec/BACKLOG.md` — item 20 closed

## Phase 6 — Out of scope, recorded

- [x] `shared/scanners/opencode.js` has its own copy of the same `sqlite3 -readonly`
      pattern and the same exposure. It was not touched here because it is a Tier 1
      adapter with a different cursor and deserves its own verification.
      **Closed by v1.26.71**, which also moved the fallback into
      `shared/scanners/sqlite-cli.js` so a third copy cannot appear.
- [ ] Nothing proves the fallback is reached on Windows. The logic is platform-neutral
      and the paths are built with `path.join`, but no Windows machine ran it.

## Phase 7 — Correction made in v1.26.71

- [x] `spec.md` and `proposal.md` still described `immutable=1` and `pathToFileURL`, the
      second of the three designs above. Phase 2 recorded that it was retired and the
      spec never got the change, so the normative document for this release described an
      implementation that does not exist. Both corrected, and the sidecar requirement
      that actually shipped was added as its own scenario.
