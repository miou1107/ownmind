# v1.26.127 — Tasks

- [x] Write the failing test first: anchors resolve, no tip text is duplicated outside the
      shared module, templates checked per tip line
- [x] `shared/tips.js` — one list, `{ text, anchor }` per entry, plus `getRandomTip` and
      `renderTipPool`
- [x] Audit all 28 existing tips against the code; drop the four describing things that do not
      exist, reword the ones that overstated
- [x] Read-through with Vin: drop four written for OwnMind's maintainers rather than its
      users, add four for the everyday moments that had none, strip example project names
- [x] `mcp/index.js` — drop its own `TIPS` / `getRandomTip`, import from `shared/tips.js`
- [x] `src/routes/memory.js` — `INSTRUCTIONS_SOP` interpolates `renderTipPool()`
- [x] `hooks/lib/render-session-context.js` — emit a tip on the SessionStart path, which asked
      for one and never supplied it (the source of the tips unrelated to OwnMind)
- [x] `configs/AGENTS.md` / `GEMINI.md` / `global_rules.md` / `copilot-instructions.md` /
      `antigravity.md` — relay OwnMind's Tip, forbid inventing one, show nothing when absent
- [x] Mutation check: a fake anchor, a re-pasted tip, and one reverted tip line each turn the
      guard red
- [x] `npm test` green; version, CHANGELOG, FILELIST and the three READMEs updated
- [ ] Code review
- [ ] Deploy — Vin's call. The server change is the operations manual served by
      `/api/memory/init`; the MCP change reaches a user when they upgrade their client
