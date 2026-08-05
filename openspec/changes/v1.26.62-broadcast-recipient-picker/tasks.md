# v1.26.62 — Tasks

Legend: `[ ]` pending · `[x]` done

Front-end only. No route, no query, no migration. TDD flow: failing tests before
source, then docs, then the three quality gates.

## Phase 0 — Reproduce and inventory (done during design)

- [x] Dialog read field-for-field: `client/src/pages/System/NewBroadcastModal.jsx`.
      Recipients are a free-text box parsed with `split(/[,\s]+/)`; end time is a text
      box defaulting to `''`
- [x] `GET /api/admin/users` confirmed to exist (`src/routes/admin.js:83`), to return
      `id, name, email, role`, and to sit behind `adminAuth`, which super_admin passes.
      Already called by TeamPage, StatsPage and BugReportsPage
- [x] `POST /api/broadcast/admin` confirmed super_admin-only, and its
      `validateBroadcastPayload` confirmed to check only that each `target_users` entry
      is a positive integer — no existence check
- [x] i18n confirmed to support `{param}` interpolation (`client/src/i18n/index.js:16`)
- [x] `SERVER_VERSION` confirmed to be derived from `package.json`
      (`src/utils/server-version.js:40`), so the version bump is one file plus the tag
- [x] Mockup shown to Vin; datetime-local chosen over a prefilled text box

## Phase 1 — RED (failing tests before any source change)

- [x] `tests/broadcast-recipient-filter.test.js` (new), covering Requirement 1:
  - [x] Query matches on `name`
  - [x] Query matches on `email`, case-insensitively
  - [x] Already-selected ids are excluded
  - [x] Empty query returns everyone not selected
  - [x] No match returns `[]`
  - [x] `null` / non-array input returns `[]` instead of throwing
- [x] `tests/broadcast-ends-at.test.js` (new), covering Requirement 2:
  - [x] `defaultEndsAtLocal` returns `YYYY-MM-DDTHH:mm` with no zone suffix
  - [x] It is exactly 30 days after the injected `now`
  - [x] `localToIso` round-trips to the same instant as the equivalent zoned string
  - [x] `localToIso` returns `null` for `''`, whitespace, `null`, `undefined`, and an
        unparseable string
- [x] Run both; confirm they fail for the right reason (module not found), not a typo

## Phase 2 — GREEN (source)

- [x] `client/src/pages/System/broadcast-recipient-filter.js` (new) — `filterMembers`
- [x] `client/src/pages/System/broadcast-ends-at.js` (new) — `defaultEndsAtLocal`,
      `localToIso`
- [x] Both test files pass

## Phase 3 — The dialog

- [x] `NewBroadcastModal.jsx`: replace the `INITIAL` constant with a `makeInitial()`
      call so the 30-day default is recomputed per open (Requirement 4, third scenario)
- [x] Fetch `/api/admin/users` on open; hold `members`, `membersError`, `selected`
- [x] Recipient field: chip list + filtered suggestion menu; each chip removable;
      no id appears in the interface
- [x] Target line under the field: everyone when empty, count when not
- [x] Load failure: inline message, search input disabled, submit still works
- [x] End-time field becomes `<input type="datetime-local">` with the hint line
- [x] Submit: `target_users` from the chosen ids when non-empty; `ends_at` via
      `localToIso` when non-null; both keys omitted otherwise
- [x] Stop passing `target_users` into `validateBroadcastFormClient`; leave that
      function and its tests untouched (Requirement 5)

## Phase 4 — i18n

- [x] `zh.json`: rewrite `system.broadcast.field.target_users` and `.ends_at`; replace
      `.target_users_placeholder`; delete `.ends_at_placeholder`; add the keys for the
      target line, the load failure, the loading state and the end-time hint
- [x] `en.json` and `ja.json` carry the same key set
- [x] Grep `client/src/` for every removed key; confirm zero references remain

## Phase 5 — Docs and version

- [x] `package.json` → `1.26.62`
- [x] `CHANGELOG.md` entry
- [x] `FILELIST.md`: two new source files, two new test files
- [x] `README.md` three-locale check. The 一鍵廣播 section describes the team-standard
      upload, not this dialog, so no prose changed; the version line did, in all three
- [x] `openspec/BACKLOG.md`: delete item 6, and note in the commit message that it
      shipped. Its claim that a new endpoint was needed was wrong; say so

## Phase 6 — Quality gates

- [x] `cd client && npm run build` — exit 0
- [x] Adversarial review through the `agy` CLI, against a copy outside the repo.
      Five findings, all five verified against the code, all five real; two arrived
      with the wrong severity. Written up in `proposal.md`
- [x] `superpowers:receiving-code-review` — each finding checked before acting, not
      implemented on sight
- [x] Fixes from the review, each with its own test where testable:
  - [x] `defaultEndsAtLocal` uses calendar days, not a fixed millisecond span
  - [x] The DST guard confirmed red against the old implementation under
        `TZ=America/New_York`, green after. It cannot be seen from Taipei
  - [x] `buildBroadcastPayload` extracted so the payload is testable at all
  - [x] `cooldown_minutes: 0` survives — regression test
  - [x] `pick` ignores an id already held, so holding Enter cannot duplicate
  - [x] Blur keyed on `relatedTarget`, replacing the 120ms timer
  - [x] ArrowDown / ArrowUp / Enter / Escape, plus combobox and listbox roles
- [x] `npm test` — 2653 tests, 2651 pass, 0 fail, 2 skipped (the 2 skips predate this
      release). One run had a transient failure in
      `tests/debug-route-beacon-version.test.js`: it binds `app.listen(0)` and the
      ephemeral port collided with something else on the machine. Passes alone, passes
      on a clean re-run, and touches nothing this release changed
- [x] `superpowers:verification-before-completion`
- [ ] Browser check against production is **not** part of this release. Creating a
      broadcast puts a message in front of every member's AI session, which is
      BACKLOG item 9 and Vin's call, not a test step

## Out of scope

- Server-side member search
- Existence checks on chosen members at send time
- Any change to 撤銷, the broadcast list, or the other dialog fields
- Backfilling `ends_at` on broadcasts already sent
