# v1.26.67 — Tasks

Legend: `[ ]` pending · `[x]` done

One shared helper, two MCP modules, one test file. No server change, no schema change,
no migration, no console change, no installer change.

## Phase 0 — Measure before designing (done)

- [x] Read all four sites and recorded the two different rules, rather than fixing the
      first one found
- [x] Confirmed `install.sh` writes `OWNMIND_TOOL: 'cursor'` (lines 577, 594) and that
      nothing in the repository writes `OWNMIND_CLIENT_TOOL`, so the variable the code
      required was one no installer produced
- [x] Confirmed `collector_heartbeat` is `UNIQUE (user_id, tool)`, which is what turns a
      mislabelled heartbeat into a *destroyed* row rather than a spurious extra one
- [x] Ruled this out as the cause of the Antigravity investigation that surfaced it: no
      OwnMind MCP process runs under Antigravity on the machine measured, so its memory
      comes from `~/.antigravity/rules/ownmind.md` and it makes no API calls at all

## Phase 1 — RED

- [x] `tests/mcp-client-tool-attribution.test.js`
- [x] Precedence, fallback, empty-as-unset, no-argument default
- [x] Source guards: neither MCP module re-implements the rule
- [x] Watched 9 fail

**Two false passes caught before implementing**, both in the guard against the
misleading comment:

- [x] The first regex ran against the raw file and passed while the file still said the
      thing, because the comment wraps between "the" and "CLIENT_TOOL"
- [x] Collapsing whitespace was still not enough: the next line's own `//` sits in the
      gap. Stripping comment markers first made it fail correctly, and a sanity
      assertion now proves the flattening did not simply eat the comments.

A guard that passes against the unfixed code asserts nothing. Both were found by
checking *which* tests passed in the red run rather than only counting failures.

## Phase 2 — GREEN

- [x] `shared/helpers.js`: `resolveClientTool(env)`
- [x] `mcp/index.js`: `CLIENT_TOOL`, and the fourth copy inside the bug-report body that
      the source guard found and the initial reading had missed
- [x] `mcp/ownmind-log.js`: shared resolver, and the comment claiming an alignment that
      did not exist is gone
- [x] Verified `mcp/ownmind-log.js` still loads after gaining a `../shared/` import

## Phase 3 — REFACTOR

- [x] `TOOL_NAME` and `CLIENT_TOOL` resolved to the identical expression after the fix.
      Two names for one answer in one file is how the rules drifted apart to begin with,
      so they are now one. Behaviour-identical, tests stayed green.

## Phase 4 — Verify

- [x] Full suite: 2754 tests, 0 failures, 2 skipped (the known v1.26.65 chmod guards)

## Phase 5 — Sync

- [x] `package.json` 1.26.67
- [x] `README.md`, `docs/README.ja.md`, `docs/README.zh-TW.md`
- [x] `CHANGELOG.md`
- [x] `FILELIST.md`

## Phase 6 — Review (done)

One round against a non-git copy outside the repo. No defect in the change itself; one
substantive correction to my own understanding of it.

- [x] **The brief understated the bug, and the reviewer said so.** I had written that
      `CLIENT_TOOL` covered "the heartbeat, the header and the session log" and
      `TOOL_NAME` was the minor one. Verified against the unfixed code and that is
      wrong: `TOOL_NAME` was used by the broadcast fetch, which is what writes
      `user_tool_last_seen`, and by the *emergency* session log, while the *normal*
      session log used `CLIENT_TOOL`. So one session reported two different identities
      depending on how it shut down. Recorded as Requirement 3.
- [x] Confirmed `shared/helpers.js` imports only `fs`/`path`/`os` and no project
      modules, so the new import from `mcp/ownmind-log.js` introduces no cycle and no
      import-time side effect
- [x] Confirmed by grep that no site derives the tool independently any more
- [x] Recorded the diagnostic consequence for reading heartbeat rows across the upgrade,
      because it directly affects the collector-silence work of v1.26.65 and v1.26.66

## Phase 7 — Out of scope, recorded rather than done

- [ ] The installer never writes an MCP config for Antigravity or Windsurf, only a rules
      file. Anyone who wires the MCP up by hand gets no tool label and lands in the
      `claude-code` bucket. Fixing it means knowing each product's canonical config path,
      which was not verified here.
- [ ] Existing `collector_heartbeat` rows already overwritten by a mislabelled heartbeat
      cannot be recovered; the correct value was never stored.
