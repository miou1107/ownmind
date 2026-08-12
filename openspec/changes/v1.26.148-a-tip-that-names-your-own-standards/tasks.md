# v1.26.148 — Tasks

## 1. Establish what the data actually looks like

- [x] Read all 32 team standards on the production account and classify them: 17 discipline,
      8 content-for-the-AI, 6 a user can ask for
- [x] Render the title-reading draft against the real rows and confirm it produces noise five
      times in six, plus one title truncated mid-parenthesis
- [x] Confirm `trigger:` tags hold keywords (`pages`, `commit`, `deploy`), not sentences
- [x] Confirm the init route already loads every visible team standard with its metadata, so
      the list costs no extra query
- [x] Confirm every caller requests `compact=true`, so the field cannot live behind `!compact`

## 2. Tests first

- [x] `validateInvocableMetadata` — flag without hint, empty/whitespace hint, non-boolean flag,
      over-long hint, hint at exactly the limit, multi-line hint, flag on a private type,
      metadata that says nothing, flag explicitly false
- [x] `buildInvocableStandards` — marked kept, unmarked dropped, flagged-but-hintless dropped
      rather than falling back to the title, truthy-but-not-true flag not treated as marked,
      duplicate sentence dropped, trimming, over-long hint dropped, non-array input
- [x] `hintsFromStandards` — payload shape, and an explicit test that the two builders are not
      interchangeable (the row-based one returns nothing for a payload list, silently)
- [x] `getRandomTip` — unchanged with no hints; malformed hint lists; the account's sentence
      appears within 400 draws; the static team-standard tip stops appearing once hints exist;
      the rest of the pool still appears; never repeats back to back with hints in play
- [x] Wiring: init payload (and not behind `!compact`), validation on both write paths, the
      hook's tip call, the MCP tip call and where it learns the hints

## 3. Implementation

- [x] `shared/invocable-standards.js` — `INVOCATION_HINT_MAX`, `validateInvocableMetadata`,
      `buildInvocableStandards` (rows), `hintsFromStandards` (payload)
- [x] `shared/tips.js` — `getRandomTip({ invocableHints })`, replacing the static
      team-standard entry rather than growing the pool
- [x] `src/routes/memory.js` — `invocable_standards` in the init response; validation on
      `POST /` and on `PUT /:id` when metadata is supplied
- [x] `hooks/lib/render-session-context.js` — hints from the init data it already has
- [x] `mcp/index.js` — hints learned at init, reused on every later response's tip

## 4. Both ends (IR-022)

- [x] Server: init payload + write validation
- [x] MCP client: tip call + init capture
- [x] SessionStart hook: tip call
- [x] `tests/tip-every-call.test.js` updated — the call now takes an argument, so the
      assertion pins "called, and not behind a condition" instead of "called with no arguments"
- [ ] Admin console: no memory editor exists, so nothing to add there

## 5. Verify

- [x] Full suite: 4,706 tests, 0 fail
- [ ] `superpowers:requesting-code-review` — dispatched on the code commit while this
      paperwork was being written, rather than after it (measured: two reviewers run
      concurrently and take ~10 minutes; writing docs first made that time serial for no
      reason)
- [ ] `superpowers:receiving-code-review`
- [ ] After deploy: mark the six standards, then confirm a real session start shows one of
      their sentences

## 6. Release paperwork

- [x] `package.json` → 1.26.148
- [ ] README (en / zh-TW / ja) — IR-032
- [ ] FILELIST
- [ ] CHANGELOG, referencing issue #85
- [ ] Deploy is Vin's call (IR-136)

## 7. Deliberately not done

- [x] No standard is marked by the code; marking is data
- [x] No inference from titles or tags — a standard with no flag never appears in a tip
- [x] `renderTipPool()` unchanged: the manual lists the static pool, and a company's own
      sentences are per-account
- [x] No translation of a company's sentence. It is stored in the words its author wrote, and
      the tip line already instructs the AI to translate what it relays
