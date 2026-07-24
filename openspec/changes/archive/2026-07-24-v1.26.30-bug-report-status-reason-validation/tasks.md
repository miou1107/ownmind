# Tasks — v1.26.30 bug-report status_reason validation

## Phase 1: TDD (done)

- [x] Write tests/bug-report-status-reason.test.js (source-level check on
      src/routes/bug-reports.js PATCH handler). Verified RED (0 pass / 3 fail).
- [x] src/routes/bug-reports.js: add ALLOWED_STATUS_REASONS constant + enum
      guard returning 400. Verified GREEN.

## Phase 2: Quality gates (done)

- [x] verification-before-completion — red-green replay (stash impl → 0/3,
      pop → 3/0) + full suite 2052 pass / 0 fail.
- [x] requesting-code-review — verdict merge-with-fixes: 1 Important (test
      claimed to catch DB drift but only did a subset check, never reading
      db/017), 2 Minor (source-level test can't exercise runtime — accepted
      precedent; pre-existing Chinese strings in the file).
- [x] receiving-code-review — Important fixed: test now parses the constant
      AND the db/017 CHECK IN(...) list and asserts deepEqual of the sorted
      sets; proven by a drift-injection replay (remove a value → fail,
      restore → pass). Minor #1 accepted (runtime covered by live check).
      Minor #2 (Chinese strings) deferred to a planned single-file
      translation pass to avoid an inconsistent partial edit.

## Phase 3: Release

- [x] package.json 1.26.29 → 1.26.30; CHANGELOG; FILELIST; trilingual README
      version lines; commit; tag; push.
- [x] Deploy server + verify live (bogus status_reason → 400).
