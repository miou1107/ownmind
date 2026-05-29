# v1.20.4 — Retire the old /admin/ and /me/ (blue-green switch)

- **Status**: stub (pending expansion after the v1.20.3 release + a 2-week observation period)
- **Depends on**: all of v1.20.0~v1.20.3 released + Vin's go-ahead "ready to retire"

## One-line summary

301-redirect the old `/admin/` and `/me/` routes (which ran blue-green alongside for a while) to the new `/dashboard/`, move the old static files to a legacy folder to keep a historical snapshot, and remove the new footer's "⚠️ 看舊版" link.

## Pre-retirement must-pass checklist
- [ ] The new `/dashboard/` runs live for 2 weeks, zero major bugs
- [ ] Vin (Super Admin) uses `/dashboard/` daily for half a day with no friction
- [ ] All old features are matched in the new version (item-by-item comparison table checked off, including all three roles + tri-language + responsive)
- [ ] Tested across 3 browsers + mobile device
- [ ] Vin explicitly gives the go-ahead "ready to retire"

## Retirement actions
- [ ] Change `src/app.js`: `/admin/` and `/me/` become `res.redirect(301, '/dashboard/')`
- [ ] `src/public/index.html` → `src/public/legacy-admin-v1.html` (add a header comment)
- [ ] `src/public/me/` → `src/public/legacy-me-v1/` (same as above)
- [ ] Remove the new footer's "⚠️ 看舊版" link
- [ ] CHANGELOG / FILELIST sync
- [ ] Close GitHub issue #44 (wrap up the whole v1.20 series)
