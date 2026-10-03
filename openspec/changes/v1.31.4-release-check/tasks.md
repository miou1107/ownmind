# Tasks — v1.31.4 release check

- [ ] `shared/release-git.js` — base detection, behind count, last tag, commits since
- [ ] `src/routes/release.js` — `GET /check`, `POST /tag` (factory router)
- [ ] `scripts/release-check.js` + the `ownmind release-check` CLI entry
- [ ] `hooks/ownmind-iron-rule-check.js` — Bash branch: `git tag` / `git push --tags` run the
      check; behind-base denies; everything else is context
- [ ] `hooks/locales/{zh,en,ja}.json` — the blocking line and the section headers
- [ ] tests: base detection on fixtures, behind/not-behind, tag-hook deny/allow/ignore,
      server answer against a fake query, tag recording refuses on an unreviewed card
- [ ] `docs/release-check.md`
- [ ] CHANGELOG, FILELIST, README ×3, version
- [ ] Deploy: no migration (reads tasks and lessons tables from v1.31.0/v1.31.3); tag
