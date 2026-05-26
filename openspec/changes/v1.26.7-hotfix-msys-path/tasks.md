# v1.26.7 — Tasks

- [x] Add `tests/path-to-win32.test.js` (mock `process.platform=win32`; round-trip /c/... ↔ C:\...)
- [x] Add `tests/path-helpers-bash.test.js` (spawn bash; simulate cygpath present/absent)
- [x] Create `scripts/install-helpers/path-helpers.sh` (`to_win_path()` helper using `cygpath -m`)
- [x] Fix 7 path-interpolation call sites:
  - [x] `hooks/ownmind-session-start.sh:179`
  - [x] `scripts/interactive-upgrade.sh:133`
  - [x] `scripts/interactive-upgrade.sh:213`
  - [x] `scripts/verify-upgrade.sh:34`
  - [x] `scripts/verify-upgrade.sh:49`
  - [x] `scripts/check-sync.sh:53`
  - [x] `scripts/check-sync.sh:71`
- [x] `npm test` 1956 + new tests / 0 fail
- [x] `package.json` 1.26.6 → 1.26.7
- [x] CHANGELOG.md / FILELIST.md / trilingual READMEs
- [x] Commit + tag v1.26.7
- [x] Push origin (Vin confirmed in the bug report)
