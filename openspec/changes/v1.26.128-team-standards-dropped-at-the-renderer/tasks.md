# v1.26.128 — Tasks

- [x] Tests first: digest rendered, `standard_detail` named, section absent when empty,
      ordered after the iron rules
- [x] `hooks/lib/render-session-context.js` — render `team_standards_digest`
- [x] `shared/tips.js` — the two tip wordings Vin asked for
- [x] Mutation check: removing the block turns three of the four tests red
- [x] `npm test` green; version, CHANGELOG, FILELIST and the three READMEs updated
- [ ] Code review
- [ ] Deploy — Vin's call. This one is client-side: the fix reaches a user when their hook is
      upgraded, not when the server is rebuilt
