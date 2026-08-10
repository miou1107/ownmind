# v1.26.131 — Tasks

- [x] Measure it rather than infer it: nine users, seven current with 41–5531 activity events,
      two stale with zero — and both stale machines heartbeating daily. The control matters,
      because "no events" on its own is equally consistent with a server-side fault
- [x] Find the asymmetry in code: the heartbeat is an unbuffered POST touching no filesystem;
      `logEvent` writes locally first and buffers second, inside one `catch {}`
- [x] `tests/mcp-log-event-windows-home.test.js` — red first, on all three defects
- [x] `resolveLogsDir()` — `HOME || USERPROFILE || os.homedir()`, resolved per call
- [x] `logEvent` — buffer before write; the local write gets its own `try`
- [x] Update outcomes join `IMMEDIATE_FLUSH_EVENTS`
- [x] Mutation check, each fix reverted separately against a file backup (9 pass baseline):
      `HOME || ''` → 3 fail, write-before-buffer → 1 fail, outcomes removed from the set →
      4 fail. Restored byte-identical to the backup afterwards
- [x] `npm test` green — 4220 pass, 23 skipped
- [x] Consulted Antigravity on its own extension points. Its immediate-flush recommendation
      and its account of MCP termination on Windows were kept; its named hook config files
      (`~/.gemini/config/hooks.json`, `.agents/hooks.json`) do not exist on this machine and
      were not acted on
- [ ] Code review
- [ ] Ship — Vin's call
- [ ] Separate decision, still open: Codex and Antigravity have only the MCP-startup updater,
      where Claude Code, Gemini CLI and Cursor have two. Worth deciding **after** the next
      update outcome from those two machines actually arrives, since that will say which step
      is failing rather than leaving it to be guessed
