# Tasks — v1.26.142

## Reproduce first

- [x] Test: an adapter that throws currently produces no heartbeat (red before the fix)
- [x] Test: `OWNMIND_SKIP_TOOLS=codex` currently produces no heartbeat (red before the fix)
- [x] Test: `--quick` currently never runs `usage_roundtrip` regardless of elapsed time

## Collector

- [x] `shared/scanners/reasons.js`: add `ADAPTER_ERROR`, `SKIPPED_BY_CONFIG` to the closed set
- [x] `hooks/ownmind-usage-scanner.js`: on a thrown adapter, POST a failure heartbeat
- [x] `hooks/ownmind-usage-scanner.js`: on a config-skipped tool, POST a skip heartbeat
- [x] Both report paths swallow their own errors and never end the loop

## Server

- [x] `src/routes/usage/events.js`: accept the two new reasons (via `isReason`, no code change needed)
- [x] `src/routes/usage/events.js`: write one `collector_error` audit row when, and only when,
      the reason is `adapter_error` and an `error` string is present
- [x] Truncate the message to 1000 chars before it reaches the audit row

## Self-check

- [x] `scripts/install-helpers/self-check.cjs`: marker-based weekly gate for `usage_roundtrip`
- [x] `checkNamesFor({ quick })` reflects the gate, so the declared set stays truthful
- [x] Marker written after the check runs, on both quick and full paths
- [x] Marker read/write failures degrade towards running the check

## Delivery (added after the collector work, same root shape)

- [x] `shared/auto-update.js`: one implementation of the full upgrade, everything injected
- [x] `mcp/index.js` delegates to it; its own lock acquire/release removed
- [x] The scheduled scanner runs it after the scan, sharing marker and lock with the MCP
- [x] Retarget the source-read tests that followed the code out of `mcp/index.js`

## Verify

- [x] Mutation-test each new assertion: break the production line, confirm the test goes red
      (LOCAL_BLOCKERS, truncation, the audit-row guard, the weekly gate in both directions,
      the adapter deadline default in both directions — every one caught)
- [x] Full suite green
- [x] End-to-end on a real machine: all five adapters scan, the upgrade step runs and
      correctly skips on an already-stamped day
- [x] Positive control: `OWNMIND_SKIP_TOOLS=opencode` moved that row's timestamp on
      production, and the running v1.26.141 server stored a null reason — the forward
      compatibility the closed set is supposed to give. The codes become visible when the
      server is upgraded.
- [x] Confirm the message reaching `usage_audit_log` carries no API key and no home path

## Docs

- [x] CHANGELOG.md
- [x] FILELIST if any file is added
