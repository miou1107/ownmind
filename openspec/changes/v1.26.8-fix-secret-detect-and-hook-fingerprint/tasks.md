# v1.26.8 — Tasks

- [x] Add reproduction tests to `tests/secret-detect-unit.test.js`
      (slash-separated paths must not hit heuristic:long_alnum)
- [x] Fix `shared/secret-detect.js`: add `SLASH_SEPARATED_PATH_REGEX`,
      wire it into the heuristic
- [x] Add `tests/git-pre-commit-fingerprint.test.js` (dispatch logic test)
- [x] Refactor `hooks/ownmind-git-pre-commit.js` `formatBlockMessage` to
      dispatch fingerprint by block reason
- [x] `npm test` — baseline 1980 + new tests, 0 fail
- [x] `package.json` 1.26.7 → 1.26.8
- [x] CHANGELOG.md / FILELIST.md / trilingual READMEs
- [x] Commit + tag v1.26.8
- [x] Push origin (Vin confirmed during this session)
