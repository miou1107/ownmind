# v1.26.60 — Stage 8 tasks

## A — close the exposure, make going back impossible

- [ ] `legacy-admin-mount.js` always redirects; the static branch and `publicDir` go
- [ ] `signpost` removed from `FEATURE_STATES`, so the existing validator throws on it
- [ ] Tests updated: manifest, bare-mount

## B — retire the legacy console source

- [ ] `git mv src/public/index.html legacy/admin-v1.26/index.html` + header comment
- [ ] Fix the 7 tests that read it (the ledger named 3)
- [ ] `COPY src/ ./src/` no longer carries it into the image — confirm

## C — remove the signpost UI

- [ ] `Signpost.jsx`, the credential handoff, the amber sidebar marker
- [ ] Locale keys: `signpost.*`, `legacy.tab.*`, `nav.still_in_legacy` ×3
- [ ] `App.jsx` renders the real page or a wiring error, nothing else
- [ ] e2e: the signpost block goes; the retirement block stays

## D — backend dead code

- [ ] Delete `/api/admin/login` and its `authLimiter` line
- [ ] Move the `audit_logs` login write into `/api/me/login`
- [ ] Delete `writeAdminAudit` — `admin_audit_logs` exists in no migration and does not
      exist on production, so every one of those inserts has always failed into a catch
- [ ] Keep `/api/admin/setup` (the recovery path) and `/api/admin/iron-rules/*` (Vin)

## E — remove the cost calculation (Requirement 8)

- [ ] `src/routes/usage/pricing.js`, `src/utils/pricing-lookup.js`, `tests/pricing.test.js`
- [ ] `pickPricing` / `computeCost` out of `src/jobs/usage-aggregation.js`
- [ ] `cost_usd` out of the responses that still carry it
- [ ] Column stays

## F — exemptions

- [ ] Delete the CRUD routes; keep the table and every read of it

## G — a fresh clone can start

- [ ] `npm start` builds the console when it is missing

## H — finish

- [ ] Dockerfile comments describe what is actually there
- [ ] Confirm `/setup` still resolves
- [ ] Close the loop on `openspec/changes/archive/v1.20.4-legacy-retire/`
- [ ] Confirm the Requirement 5 guard did real work
- [ ] CHANGELOG / FILELIST / README ×3 / package.json / umbrella ledger
- [x] `superpowers:verification-before-completion` — suite 2606/0, client build exit 0,
      e2e 41/0
- [x] `superpowers:requesting-code-review` — adversarial pass, one bundled file
- [x] `superpowers:receiving-code-review` — 0 Critical, 4 Important, 2 Minor claimed. Each
      checked against the code before acting; **half were wrong**, which is why they get
      checked:
      - **Important, nightly recompute erases historical cost — real, fixed.** The release
        documented "historical rows untouched", and it was false: `ON CONFLICT ... cost_usd
        = EXCLUDED.cost_usd` with EXCLUDED always NULL, while nightly-recompute re-runs the
        last seven days and ingestion re-runs any day with new events. The first night
        would have blanked a rolling window. `cost_usd` is now left out of the DO UPDATE
        entirely; new rows still insert NULL. Regression test mutation-verified
      - **Important, double-slash bypasses the login limiter — refuted, but pinned.**
        `/api/me//login` does miss `app.use('/api/me/login')`. It also misses the login
        route, falls through to `router.use(auth)` and is rejected for having no token, so
        no password is checked. Measured, not reasoned about. A test now holds the second
        half in place, because moving the login below the auth guard would make the
        review's version true
      - **Important, front-end KPI cards will render undefined — refuted.** No component
        reads any `kpi.*` key; they are v1.20 prototype leftovers. The reviewer inferred it
        from "the absence of UI component diffs". The client builds and the e2e suite walks
        every page
      - **Important, the iron-rule audit write will throw on a string id — refuted.**
        `ruleId = parseInt(req.params.id, 10)` and `target_id` is `INT`. The reviewer
        assumed the id was a rule code like `IR-006`; the route takes a memory id
      - **Minor, the Dockerfile guard could pass on a comment — fair, tightened.** It
        matched the whole file with `includes()`. The comment above that COPY does not
        contain the path, so the mutation check did go red — but it was one edit away from
        vacuous. It parses COPY directives now
      - **Minor, a vacuous e2e text assertion — fair, fixed.** The amber marker lived in
        `title`/`aria-label`, never in visible text, so searching visible text for it
        proved nothing. Matches the attribute now, plus the signpost page's own copy
- [ ] Deploy + production browser check
