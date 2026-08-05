# v1.26.63 — Tasks

Legend: `[ ]` pending · `[x]` done

Server plus console. No schema change, no migration, no new token type.
TDD flow: failing tests before source, then docs, then the quality gates.

## Phase 0 — Reproduce and inventory (done during design)

- [x] `POST /api/me/login` returns `api_key` regardless of `must_change_password`
      (`src/routes/me.js:70`)
- [x] Nothing in `src/middleware/` reads the flag. Every occurrence in `src/` is a read
      for display or a write on set/reset
- [x] `seedDefaultPasswords` sets the flag for every account with no `password_hash`,
      which is everyone who never opened the console. `src/routes/me.js:722` carries a
      reverse-audit query built for exactly those people
- [x] Only the console calls `/api/me/login`. Grep across `mcp/`, `hooks/`, `scripts/`,
      `shared/` finds no other caller, so no installed client is affected
- [x] `authLimiter` is mounted on `/api/me/login` (`src/app.js:61`), 10 per 15 minutes,
      overridable by `AUTH_RATE_LIMIT_MAX`
- [x] `LoginPage` already has a two-value `mode` state, so a third is the existing shape
- [x] e2e accounts are seeded with `must_change_password = FALSE`, so the suite is
      unaffected
- [x] Mockup shown to Vin; scope fixed at "source only", `api_key` rotation deferred

## Phase 1 — RED (failing tests before any source change)

- [x] `tests/login-outcome.test.js` — extend for Requirement 3:
  - [x] `{ mustSetPassword: true }` → `{ kind: 'first_password' }`
  - [x] `{ mustSetPassword: 'yes' }` → `{ kind: 'error' }`
  - [x] `requiresSetup` still wins where both could apply
  - [x] the three existing outcomes unchanged
- [x] `tests/first-password.test.js` (new) — Requirements 1 and 2 against the pure policy
      in `src/utils/first-password.js`, following `src/utils/setup-recovery.js`. Not
      against the route: `me.js` has no dependency injection, and the source-regex style
      of `tests/me-change-password-status.test.js` is too weak for a credential path:
  - [x] Login with the flag `TRUE` → 200, `mustSetPassword`, no `api_key` key present
  - [x] Login with the flag `TRUE` and a wrong password → 401, generic body
  - [x] Login with the flag `FALSE` → unchanged response including `api_key`
  - [x] `first-password` happy path → 200 with `api_key`, hash replaced, flag cleared,
        audit row written
  - [x] `first-password` with a wrong current password → 401, flag still `TRUE`
  - [x] `first-password` against an account with the flag `FALSE` → 401, password
        unchanged
  - [x] `first-password` with a short new password → 400
  - [x] `first-password` with `new_password === current_password` → 400
  - [x] `first-password` with a missing field → 400
- [x] Run both; confirm they fail for the right reason

## Phase 2 — GREEN (server)

- [x] `src/utils/first-password.js` (new) — the pure policy: what login answers for a
      given user row, and what `first-password` refuses and why
- [x] `src/routes/me.js`: login asks the policy instead of building its own response when
      the flag is `TRUE`
- [x] `src/routes/me.js`: `POST /first-password`, mounted above `router.use(auth)`
- [x] `src/app.js`: `authLimiter` on `/api/me/first-password`, plus a structural test that
      it is mounted, since forgetting it is the one mistake that would not show up in any
      behavioural test
- [x] Tests pass

## Phase 3 — GREEN (console)

- [x] `client/src/pages/login-outcome.js`: the fourth kind, before the `api_key` check
- [x] `client/src/pages/LoginPage.jsx`: `mode === 'first-password'` form, keeping the
      email and the typed temporary password; on success `setApiKey`, `prime`, navigate
      to the original destination
- [x] Confirm `RequireFreshPassword` is untouched and still covers the admin-reset case

## Phase 4 — i18n

- [x] `zh.json`: new keys for the third mode's title, explanation, submit and back
- [x] `en.json` and `ja.json` carry the same key set
- [x] Grep `LoginPage.jsx` for every `t()` key; confirm each exists in all three

## Phase 5 — Docs and version

- [x] `package.json` → `1.26.63`
- [x] `CHANGELOG.md` entry, including what is *not* closed
- [x] `FILELIST.md`
- [x] `README.md` three-locale check
- [x] `openspec/BACKLOG.md`: item 1 goes, replaced by an entry for the admin-reset path
      and the `api_key` rotation decision, which is what remains open

## Phase 6 — Quality gates

- [x] `npm test` — full suite, zero failures
- [x] `cd client && npm run build` — exit 0
- [x] Adversarial review through the `agy` CLI, against a copy outside the repo. This one
      is a credential path, so the review prompt asks specifically about oracles, timing,
      rate-limit bypass, and any response shape that leaks account state
- [x] `superpowers:receiving-code-review`
- [x] `superpowers:verification-before-completion`
- [ ] Not verified against production. Testing this path means logging in as somebody
      else's account, and the only account with the flag set is a real colleague's

## Out of scope

- `api_key` rotation on password change (Vin's decision, 2026-08-05)
- A middleware gate on `must_change_password`, which would stop every never-logged-in
  member's MCP
- Temporary password expiry
- Any change to `POST /api/me/change-password`
