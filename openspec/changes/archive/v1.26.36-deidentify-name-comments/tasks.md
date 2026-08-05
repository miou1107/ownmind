# Tasks — v1.26.36 De-identify owner name in comments

- [x] Reword 12 comments dropping "Vin" (keep meaning) across 11 files.
- [x] Extend `tests/no-hardcoded-names-in-output.test.js` with a source-scan
      guard for `\bVin\b`/`\bVincent\b` in product code files.
- [x] Grep confirms no "Vin" in scanned code files (only the legit
      package.json author remains).
- [x] Name guard green; full `npm test` green (2070 pass / 0 fail).
- [x] Release: package.json 1.26.35 → 1.26.36; CHANGELOG; FILELIST; trilingual
      README.
- [ ] Single tag v1.26.36 + deploy for v1.26.32-36 together — await Vin's go.
