> **SUPERSEDED AND CLOSED — 2026-08-05.**
>
> This change was written, archived, and never executed. The old consoles outlived their
> replacement by roughly six months as a result, which is the reason
> `shared/legacy-console-manifest.js` exists at all: a checklist in a document cannot be
> the guard, so retirement was rebuilt as a consequence of finishing rather than a task to
> remember.
>
> What it asked for did happen, under `openspec/changes/single-console-consolidation/`:
>
> | This document's action | Where it actually happened |
> |---|---|
> | 301 `/me/` to the console | v1.26.48 (Stage 1b) |
> | 301 `/admin/` to the console | v1.26.59 (Stage 7), by the manifest emptying |
> | Move the old static files to a legacy folder | `legacy/me-v1.19/` in v1.26.48, `legacy/admin-v1.26/` in v1.26.60 |
> | Remove the "see the old version" link | v1.26.60, with the whole signpost mechanism |
>
> Its pre-retirement checklist was also not what shipped. "Two weeks live, zero major
> bugs, Vin's go-ahead" was replaced by moving one feature per release, each with its own
> tests, so that at no point did anything have to be trusted to a soak period. Kept
> unedited below as the record of a plan that did not survive contact.

---

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
