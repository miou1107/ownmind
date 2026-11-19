# A preflight start of the MCP leaves no update lock behind

Ships together with the 2026-11-12 dependency update (Dependabot PR #206).

## Why

PR #206 bumps eight npm packages and nothing near the installer, yet its "clean install /
ubuntu-latest" check failed: in `tests/bootstrap-archive-mode.e2e.mjs`, the archive update run
right after a clean install answered `FAILED lock_held`.

The install's self-check (`scripts/install-helpers/self-check.cjs` → `mcp-preflight.cjs`) starts
the registered MCP, completes the handshake, counts the tools and kills it. On start the MCP ran
its daily auto-update. On an archive install that update takes `~/.ownmind/.update-lock` and
sends `HEAD /api/install/archive`. If the kill lands before the answer, the SIGTERM handler calls
`process.exit(0)`, the update's `finally` never runs, and the lock stays until `STALE_MS`
(ten minutes) has passed. Every update in that window is refused — the CI's archive update, and on
a real machine the upgrade a person runs right after installing.

Measured on 2026-11-19: an MCP started against a server that never answers the release request
holds the lock while it waits, and the lock is still on disk after it exits on SIGTERM. Locally the
update usually finishes before the kill (`update_clean` in the log), which is why the e2e passes on
a Mac and failed on a Linux runner.

## What changes

- `mcp/index.js`: when `OWNMIND_PREFLIGHT=1` (set by `mcp-preflight.cjs`, already used to skip the
  heartbeat), the MCP does not start the auto-update and logs `update_skipped` with
  `reason: preflight`.
- `tests/mcp-preflight-skips-update.test.js`: a normal start asks for the release and holds the
  lock (the control); a preflight start sends no release request and creates no lock.

## Not in this change

- Releasing the lock from the MCP's signal handlers. A dying MCP can leave `npm install` children
  writing into the staging tree; freeing the lock at that moment would let a second updater start
  on top of them. The stale-lock reclaim stays the recovery for a kill during a real update.
- Server code. The dependency bumps are Dependabot's, unchanged.
