# v1.26.96 — Tasks

- [x] `.gitattributes`: glob for `hooks/ownmind-git-*`, plus `*.js` / `*.cjs` / `*.mjs`
- [x] `tests/shebang-eol.test.js`: derive the list from `git ls-files`, fail closed
- [x] `install.sh`: `install_git_hook` strips CR instead of `cp`
- [x] Break each guard once — remove the hook glob, remove `*.js`
- [x] Installer copy verified end to end: CRLF in, LF out, still executable, still runs
- [x] CHANGELOG, FILELIST, README ×3, `package.json` → 1.26.96
- [ ] `superpowers:requesting-code-review`
- [ ] Open the PR, and reply on bug #17. **Do not merge, tag or deploy** — Vin decides
