# v1.26.59 — 週報月報 tasks

## Server

- [x] `src/utils/report.js` — `computeReportData` emits `sessions_analyzed` and stops
      pretending to know `friction_issues_created` (it hardcodes 0 and the route
      overwrites it; the route is the only honest source)
- [x] `src/routes/session.js` — one query counting both auto-created memory kinds with
      `COUNT(*) FILTER`, so the two cards cannot drift apart; a second counting every
      `session_logs` row in the window regardless of `details` / `compressed`
- [x] Response gains `sessions_total`, `sessions_analyzed`, `suggestion_actions_created`,
      `period_start`, `period_end`, `detail_retention_cutoff`

## Client

- [x] `client/src/pages/Portal/periodic-report-vm.js` — pure: period options, offset
      options, the four emptiness states, the retention caveat, card values
- [x] `client/src/pages/Portal/PeriodicReportsPage.jsx` — control bar, three cards, two
      lists, request gate
- [x] `client/src/pages/Portal/MemorySearchModal.jsx` — ports `searchMemory`
- [x] i18n keys in all three locales under `periodic.*` (`reports.*` is 回報紀錄)
- [x] `nav-sections.js` — `/portal/periodic-reports` drops from `admin` to `user`
- [x] `App.jsx` — real page replaces the signpost
- [x] `shared/legacy-console-manifest.js` — `periodic-reports` → `live`

## Tests

- [x] `tests/report.test.js` — extend for the new `computeReportData` fields
- [x] `tests/periodic-report-vm.test.js` — new, covering all four emptiness states, both
      retention cases, and the card values
- [x] `tests/legacy-console-manifest.test.js` — the manifest is now empty; assert
      retirement rather than "one signpost left"
- [x] `tests/e2e/console.spec.mjs` — mirror spec asserting `/admin/` redirects when
      nothing is signposted
- [x] Mutation-verify the retirement spec and at least one Requirement C state

## Docs

- [x] CHANGELOG, FILELIST, README ×3, package.json, umbrella tasks.md

## Quality gates

- [x] `superpowers:verification-before-completion` — suite 2628/0, client build exit 0,
      e2e 43/0
- [x] `superpowers:requesting-code-review` — adversarial pass. The first run timed out
      with no output: print mode was waiting on tool-permission prompts nobody could
      answer, and the input was spread over a dozen files. Rerun with everything
      bundled into one file, `--dangerously-skip-permissions` (safe: the reviewer only
      ever sees the non-git scratch copy) and a longer print timeout
- [x] `superpowers:receiving-code-review` — 2 Critical, 1 Important, 1 Minor claimed.
      Each checked against the code before acting:
      - **Critical 1, account enumeration — real, fixed.** The no-password branch
        answered '此帳號尚未設定密碼，請聯絡管理員' while unknown-email answered
        '帳號或密碼錯誤', so probing addresses revealed which are real accounts. The
        message predates this change, but this is the branch being rewritten and the
        spec promised the response reveals nothing, so the claim and the code had to
        agree. All three rejection branches now return one frozen `LOGIN_REJECTED`.
        The reviewer also correctly noted my test asserted only that *an* error was
        present — it now compares against that constant
      - **Critical 2, missing import — wrong.** `SESSION_RETENTION_DAYS` is imported at
        `src/routes/session.js:5` and has been since long before this change; the
        reviewer saw only the diff hunk. Refuted by running evidence too: the e2e specs
        load the page and assert numeric cards, which a 500 could not produce
      - **Important, compression summaries counted as sessions — real, fixed.**
        `sessions_total` counted every row, including the summary `compressOldSessions`
        leaves behind, so an expired window rendered "records exist but nobody filled in
        the reflection fields — that is a reporting gap" when the truth is the reverse.
        Split into live and compressed counts and given its own state,
        `compressed_only`, which says the notes existed and retention discarded them
      - **Minor, microsecond boundary — real, deferred with reason.** `created_at <= end`
        where end is `…59.999` can miss a row at `…59.9995`, and postgres keeps
        microseconds. It is `computePeriodRange`'s contract, shared with the weekly and
        monthly cron jobs that *write* data, and this change's proposal lists redesigning
        it as a non-goal. Recorded in the umbrella ledger instead of changing period
        maths in a release about presentation
- [ ] Deploy + production browser check

## Found by my own review while the adversarial pass ran

- [x] The page kept the previous period's cards and lists on screen while a refetch was
      in flight, so the selects said 月報 while the numbers below were the week's. The
      request gate does not cover this — it stops a late *write*, not a stale *render*.
      The payload now records which selection produced it and nothing renders unless it
      matches. Both guards are separately mutation-verified: removing either turns a
      different e2e spec red
- [x] The retention wording said the detail "has been compressed". `compressOldSessions`
      runs opportunistically off a memory write, not on a schedule, so an old window may
      still hold everything. Softened to "not guaranteed complete", which is true either
      way
- [x] `/setup` on an installed system redirected to `admin/login`, a URL that has never
      resolved — the legacy console is `express.static` and there is no file under
      `login/`. Retiring `/admin` would have turned it into a chain that lands somewhere
      right by accident. Points at `dashboard/login` now
