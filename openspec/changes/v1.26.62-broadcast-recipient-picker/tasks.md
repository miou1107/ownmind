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

- [ ] `tests/broadcast-recipient-filter.test.js` (new), covering Requirement 1:
  - [ ] Query matches on `name`
  - [ ] Query matches on `email`, case-insensitively
  - [ ] Already-selected ids are excluded
  - [ ] Empty query returns everyone not selected
  - [ ] No match returns `[]`
  - [ ] `null` / non-array input returns `[]` instead of throwing
- [ ] `tests/broadcast-ends-at.test.js` (new), covering Requirement 2:
  - [ ] `defaultEndsAtLocal` returns `YYYY-MM-DDTHH:mm` with no zone suffix
  - [ ] It is exactly 30 days after the injected `now`
  - [ ] `localToIso` round-trips to the same instant as the equivalent zoned string
  - [ ] `localToIso` returns `null` for `''`, whitespace, `null`, `undefined`, and an
        unparseable string
- [ ] Run both; confirm they fail for the right reason (module not found), not a typo

## Phase 2 — GREEN (source)

- [ ] `client/src/pages/System/broadcast-recipient-filter.js` (new) — `filterMembers`
- [ ] `client/src/pages/System/broadcast-ends-at.js` (new) — `defaultEndsAtLocal`,
      `localToIso`
- [ ] Both test files pass

## Phase 3 — The dialog

- [ ] `NewBroadcastModal.jsx`: replace the `INITIAL` constant with a `makeInitial()`
      call so the 30-day default is recomputed per open (Requirement 4, third scenario)
- [ ] Fetch `/api/admin/users` on open; hold `members`, `membersError`, `selected`
- [ ] Recipient field: chip list + filtered suggestion menu; each chip removable;
      no id appears in the interface
- [ ] Target line under the field: everyone when empty, count when not
- [ ] Load failure: inline message, search input disabled, submit still works
- [ ] End-time field becomes `<input type="datetime-local">` with the hint line
- [ ] Submit: `target_users` from the chosen ids when non-empty; `ends_at` via
      `localToIso` when non-null; both keys omitted otherwise
- [ ] Stop passing `target_users` into `validateBroadcastFormClient`; leave that
      function and its tests untouched (Requirement 5)

## Phase 4 — i18n

- [ ] `zh.json`: rewrite `system.broadcast.field.target_users` and `.ends_at`; replace
      `.target_users_placeholder`; delete `.ends_at_placeholder`; add the keys for the
      target line, the load failure, the loading state and the end-time hint
- [ ] `en.json` and `ja.json` carry the same key set
- [ ] Grep `client/src/` for every removed key; confirm zero references remain

## Phase 5 — Docs and version

- [ ] `package.json` → `1.26.62`
- [ ] `CHANGELOG.md` entry
- [ ] `FILELIST.md`: two new source files, two new test files
- [ ] `README.md` three-locale check — expected to need nothing, since no user-facing
      capability is added or removed; record the check either way
- [ ] `openspec/BACKLOG.md`: delete item 6, and note in the commit message that it
      shipped. Its claim that a new endpoint was needed was wrong; say so

## Phase 6 — Quality gates

- [ ] `npm test` — full suite, zero failures
- [ ] `cd client && npm run build` — clean
- [ ] `superpowers:verification-before-completion`
- [ ] Adversarial review through the `agy` CLI, against a non-git copy of the changed
      files
- [ ] `superpowers:receiving-code-review` on whatever comes back
- [ ] Browser check against production is **not** part of this release. Creating a
      broadcast puts a message in front of every member's AI session, which is
      BACKLOG item 9 and Vin's call, not a test step

## Out of scope

- Server-side member search
- Existence checks on chosen members at send time
- Any change to 撤銷, the broadcast list, or the other dialog fields
- Backfilling `ends_at` on broadcasts already sent
