# v1.26.72 — Tasks

Legend: `[ ]` pending · `[x]` done

## Phase 0 — Find out what already exists

- [x] **`scripts/install-helpers/self-check.cjs` already runs at the end of every install
      and upgrade, and has since v1.17.63.** 838 lines, 8 checks, writes a local log and
      uploads to `/api/debug/install-check`. This was found before writing a second thing
      with the same name, not after.
- [x] Read all 8: mcp files, package version, mcp node_modules, server health, api key
      format, api credentials, git hooks, scheduler. **Every one asks "is it installed and
      can I authenticate". None asks whether the data is arriving** — which is the state
      every collector defect this week was in.
- [x] Confirmed the callers: `install.sh`, `install.ps1`,
      `scripts/interactive-upgrade.ps1`. `hooks/ownmind-session-start.sh` calls only
      `retrySpool`, so the new check does **not** fire on every AI session.

## Phase 1 — RED

- [x] `tests/selfcheck-report.test.js` — 21 tests, the pure comparison
- [x] `tests/selfcheck-endpoint.test.js` — 10 tests, the server route over real HTTP
- [x] `tests/selfcheck-entry.test.js` — 11 tests, the standalone command
- [x] `tests/self-check-usage-roundtrip.test.js` — 13 tests, the ninth check in the
      existing installer helper, including one asserting it is actually wired into
      `runAllChecks` (a check nobody calls is not a check)

## Phase 2 — GREEN

- [x] `shared/scanners/selfcheck.js` — `buildSelfCheckReport` (pure),
      `renderSelfCheckReport`, `fetchSelfCheck` (errors returned, never thrown)
- [x] `src/routes/usage/self-check.js` — GET, plain `auth`, own rows only, no user
      parameter, never joins `users`
- [x] `hooks/ownmind-selfcheck.js` — the standalone command
- [x] `scripts/install-helpers/self-check.cjs` — ninth check `usage_roundtrip`, last in
      the list because it is the only slow one
- [x] `hooks/ownmind-usage-scanner.js` — `main()` returns its per-tool results.
      Deliberately **without** credentials: a secret that travels in a return value ends
      up in somebody's log eventually.

## Phase 3 — Verify

- [x] Against **production**, which is still on v1.26.67: the scan ran and 124 events were
      accepted, then the endpoint came back 404 and the check reported
      `warn: this server does not have the self-check endpoint yet`. The old-server path is
      the one that could only otherwise be tested with a stand-in.
- [x] Against a **real HTTP server running the real router**, with `antigravity`
      deliberately recorded against `TANK`:

      [ OK ] claude-code    the server has this machine's check-in.
      [ OK ] codex / opencode / cursor
      [WARN] antigravity    the server currently records this tool against "TANK"

- [x] The unreachable-server path, hit for real by accident when the first end-to-end
      attempt could not resolve `express`: `warn`, install not broken.
- [x] Full suite

## Phase 4 — Review

One round against a non-git copy outside the repo. Three findings, all three real, all
three fixed — and the first one is the important one.

- [x] **`sameMachine(null, X)` returned true, so an unknown machine read as `confirmed`.**
      This was a deliberate choice with the reasoning written next to it — "unknown is not
      somebody else" — and it produced the exact outcome the change exists to prevent.
      `collector_heartbeat` is UNIQUE (user_id, tool), so there is **one row per tool for
      the whole account**: a fresh row with no machine name is indistinguishable from
      another computer's, and a machine whose upload is silently failing would read its
      neighbour's heartbeat as proof of its own success. Now a fifth verdict,
      `unattributed`, which warns.
- [x] **No `Cache-Control` on the endpoint.** Every member calls the identical url and is
      told apart by a header, so a shared cache keyed on the url could serve one person's
      machine names and counts to the next. Checked rather than assumed: helmet sets none.
      Now `no-store, private`, with a test.
- [x] **The api key could reach the caller inside a fetch error.** Both callers happened to
      redact, but the value is known in `fetchSelfCheck` and nowhere else guarantees the
      next caller will. Measured rather than argued: a key containing a newline makes fetch
      throw `Headers.append: "<the key>" is an invalid header value`, carrying it verbatim.
      Redacted at the source now.
- [x] **A crash introduced by the first fix, caught by writing its test.** The installer's
      warning branch reached for `.find(r => r.verdict === 'other_machine').server_machine`,
      which is undefined when the only warning is an unattributed row. `safeCheck` would
      have turned that TypeError into a `fail` — reporting a broken collector on a healthy
      machine, which is the false alarm the spec forbids.

## Phase 5 — Sync

- [x] `package.json` 1.26.72
- [x] `README.md`, `docs/README.ja.md`, `docs/README.zh-TW.md`
- [x] `CHANGELOG.md`
- [x] `FILELIST.md` — the three new source files
- [x] `self-check.cjs` header — "7 checks" was already wrong before this change and is now
      9

## Phase 6 — Out of scope, recorded

- [ ] The environment and debug snapshot. It needs `collector_heartbeat` to be per-machine
      first (backlog 14), or two computers' diagnostics overwrite each other and the
      collected data is worse than none.
- [ ] Nobody is notified. This fires when a person runs an installer; a machine that
      quietly stops reporting a month later still tells no one (backlog 4).
