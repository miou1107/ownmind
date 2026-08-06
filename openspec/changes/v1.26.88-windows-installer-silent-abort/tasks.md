# v1.26.88 — Tasks

Legend: `[ ]` pending · `[x]` done

## Phase 0 — Confirm the report rather than trust it

- [x] Read `install.sh` at the lines named. The `node -e` block ending `" 2>/dev/null` and the
      `const path = '$CLAUDE_SETTINGS';` inside it are both there as described.
- [x] Enumerate every inline Node invocation in all four shell scripts rather than the one in
      hand. Fifteen interpolate a path; three consumers of the same mistake already existed.
- [x] Found that `scripts/install-helpers/path-helpers.sh` already solves this, was added in
      v1.26.7 for Vin's 2026-05-26 report of the identical failure, and was wired into
      `interactive-upgrade.sh` alone. This is a fix that was never applied, not a fix that was
      never written.
- [x] Confirmed `rollback()` is `rm -rf "${OWNMIND_DIR}"` and `LOG_FILE` was under
      `${OWNMIND_DIR}/logs/`, so the message naming the log named a file it had just deleted.
- [x] Checked the reporter's mechanism claim about argv vs. inline source. Argv paths are
      converted by MSYS and those call sites work on the reporting machine; only the inline
      `-e` source is affected. Scope set accordingly.

## Phase 1 — Paths

- [x] `install.sh` sources `path-helpers.sh` with an identity fallback; ten interpolated
      paths routed through `to_win_path`.
- [x] `scripts/update.sh` the same; five paths, including the four
      `require('.../load-settings-safe.cjs')` calls.
- [x] `scripts/interactive-upgrade.sh` — `send_upgrade_complete_beacon` was still reading a
      raw `$HOME` path, so that beacon has never fired on a Windows machine.
- [x] The non-Windows `MCP_ENTRY` branch routed through the helper too. It is unreachable on
      Windows and identity elsewhere; one uniform rule beats an exception nobody remembers.

## Phase 2 — Errors that reach a human

- [x] Installer `node -e` stderr goes to `~/.ownmind-logs/install-<TS>.log`.
- [x] `ERR` trap prints the aborting line, the log path, and the last five lines of it.
- [x] `update.sh` log directory created before the first redirect into it — a failed `2>>`
      would otherwise make the beacon fail on every machine that lacked the directory.
- [x] Upgrade log moved to `~/.ownmind-logs/`, outside what `rollback()` replaces.

## Phase 3 — "Did it finish?"

- [x] `scripts/install-helpers/install-artifacts.cjs` — one list, two consumers. Fails closed
      on any artifact whose presence cannot be determined.
- [x] `install.sh` asserts it before the closing self-check; on failure prints `[FAIL]`, still
      runs the self-check so the state reaches the server, then exits 1.
- [x] `self-check.cjs` gains `install_complete`, so a truncated install reaches a human
      through the v1.26.87 alerting rather than waiting to be noticed.
- [x] `checkNamesFor` updated — a check that runs but is not declared breaks the existing
      "every declared check executes" test in `ensure-key-file.test.js`.

## Phase 4 — Guards

- [x] `tests/installer-node-paths.test.js` derives its offender list by parsing the scripts.
      Fails closed on an inline block whose extent it cannot determine.
- [x] `tests/install-artifacts.test.js` — presence, absence, multi-absence, wrong file type,
      unreadable path, both CLI exit codes, and a source guard that there is only one list.
- [x] Destructive checks, restored from backup copies rather than `git checkout`:
      reintroduced a raw `$CLAUDE_SETTINGS` (red), reintroduced `2>/dev/null` (red), moved the
      upgrade log back under `${OWNMIND_DIR}` (red). Green again after each restore.
- [x] Fixed `tests/upgrade-complete-beacon.test.js`: it extracts the beacon function and runs
      it in isolation, so it now sources `path-helpers.sh` as the real script does. Without
      that it was testing a version of the function that cannot exist.

## Phase 5 — Verification

- [x] Full suite green.
- [x] `install.sh` run end to end under an isolated `HOME` on macOS: completes, no spurious
      `ERR` trap output, no launchd agent registered in the real user session.
- [ ] Windows: not verified on a real machine. The change is identity on macOS, so a local
      run proves no regression and proves nothing about the fix. Needs the test account.
- [ ] Ask Vin before tagging or deploying.

## Phase 6 — Not done, deliberately

- [ ] `install.ps1` and `install.sh` take different paths on Windows and produce different
      results — ps1 completes, sh did not — while upgrades only ever run sh. Recorded in
      `openspec/BACKLOG.md`.
