# v1.26.97 — Tasks

- [x] `db/022_bug_report_confirmation_source.sql` — column, comment, backfill to `unknown`
- [x] `src/utils/confirmation-declared.js` — shared normaliser
- [x] `src/routes/bug-reports.js` — record it on insert, return it when listing, and correct
      the header comment that called it a server-side gate
- [x] `mcp/index.js` — drop the false assurance, add the required enumerated parameter,
      forward it
- [x] Tests, and five mutations confirmed red
- [x] Backlog 36 — separating the credentials
- [x] CHANGELOG, FILELIST, README ×3, `package.json` → 1.26.97
- [ ] `superpowers:requesting-code-review`
- [ ] Open the PR, reply on bug #18. **Do not merge, tag or deploy** — Vin decides
