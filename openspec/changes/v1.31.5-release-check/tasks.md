# Tasks — v1.31.5 release check

- [x] `shared/release-git.js` — base detection, behind count, last tag, commits since, the report
- [x] `src/routes/release.js` — `GET /check`, `POST /tag` (factory router)
- [x] `scripts/release-check.js` — run by hand: `node ~/.ownmind/scripts/release-check.js [--base] [--milestone] [--tag]`
- [x] `hooks/lib/release-check.js` — the runner the hook and the CLI share; the deny / context envelope
- [x] `hooks/ownmind-iron-rule-check.js` — `git tag <name>` / `git push --tags` run the check; behind-base
      denies; everything else is context; listing and deleting tags are ignored
- [x] tests: `tests/release-check.test.js` — command recognition, git facts on a fake git, the report,
      the runner with injected network, the hook against a real repository (deny / allow / ignore),
      the server half against a fake query, tag recording refuses on an unreviewed card
- [x] `docs/release-check.md`
- [x] `src/app.js` mount
- [x] CHANGELOG, FILELIST, README ×3, version
- [ ] Deploy: no migration (reads the tables of v1.31.0 and v1.31.3); tag v1.31.5

Decided against while building: the "compliance skipped" section. The commit hook's compliance
log is per machine and per rule, not per commit, so "commits since the last tag whose check was
skipped" has no honest source yet. Listed in the proposal; not shipped.

No `ownmind` CLI binary exists in this repository (the proposal assumed one); the command is the
script above.
