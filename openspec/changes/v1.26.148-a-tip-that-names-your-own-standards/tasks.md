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

- [x] Full suite: 4,712 tests, 0 fail
- [x] `superpowers:requesting-code-review` — dispatched on the code commit while this
      paperwork was being written, rather than after it (measured: two reviewers run
      concurrently and take ~10 minutes; writing docs first made that time serial for no
      reason)
- [x] `superpowers:receiving-code-review` — see §8
- [ ] After deploy: mark the five standards, then confirm a real session start shows one of
      their sentences

## 6. Release paperwork

- [x] `package.json` → 1.26.148
- [x] README (en / zh-TW / ja) — IR-032
- [x] FILELIST
- [x] CHANGELOG, referencing issue #85
- [ ] Deploy is Vin's call (IR-136)

## 7. Deliberately not done

- [x] No standard is marked by the code; marking is data
- [x] No inference from titles or tags — a standard with no flag never appears in a tip
- [x] `renderTipPool()` itself unchanged: the manual lists the static pool, and a company's
      own sentences are per-account. Its framing sentence did change — see §8
- [x] No translation of a company's sentence. It is stored in the words its author wrote, and
      the tip line already instructs the AI to translate what it relays

## 8. Code review, and what it changed

Two reviewers on different models, dispatched on the code commit while this paperwork was
being written. Neither could break `getRandomTip` (no loop, no throw, no repeat — the pool
always holds ≥24 distinct entries) and neither found an API sequence producing a flagged
standard with no sentence.

Acted on:

- [x] **The feature would have shipped dark.** Nothing in the product named the two fields:
      not the `ownmind_save` / `ownmind_update` descriptions, not the manual, and there is no
      console editor. An admin asking their AI to "make the pages standard askable" would have
      had nothing to work from. Both tool descriptions now name the pair, with the example
      sentence, and `ownmind_update`'s says in the same breath that `metadata` **replaces**
      rather than merges — the second reviewer's point that this change is what will make
      admins hand-edit a standard's metadata for the first time, and standard 869 already
      carries `lint_warnings` that a careless write would drop.
- [x] **The tip would never have changed on the surface users see most.** `currentInvocableHints`
      was captured only inside `ownmind_init`, and Claude Code loads memory through the
      SessionStart hook and never calls that tool — `configs/CLAUDE.md` says so in as many
      words. So on every MCP tool response the list would have stayed empty for the life of
      the process. The MCP now falls back to the payload the hook wrote to disk, read once per
      process, with the account check the hook itself makes.
- [x] **A multi-line hint reached the screen.** The write path refuses `\r\n`; both read-side
      filters checked only emptiness and length, and `trim()` does not touch an interior
      newline. A row written before the validation — or straight into the database — could
      therefore add lines nobody wrote to text another member's AI is told to relay. One
      predicate now enforces all three rules on both sides.
- [x] **A refusal named a consequence that does not exist**: it said an over-long hint is
      "truncated by the client that renders it". Nothing truncates; it is dropped and the
      standard goes unadvertised. Corrected.
- [x] **The reason given for refusing the flag on other types was untrue** — it said a private
      memory is never shown to anyone else, but `standard_detail` is shared. The refusal is
      right for a different reason (session start loads the summary layer only), and now says
      that.
- [x] **Three tests could not fail.** The compact guard pinned one spelling, so
      `compact ? {} : {...}` passed; the MCP wiring was regex-only, so a plausible
      "reset session state" line would have left it green; and the hook's wiring was never
      executed. Now: a behavioural render test over 400 draws, an assertion that the empty
      list is assigned exactly once, and a check that the init query still selects the
      metadata the list is built from. Mutations watched to fail: compact re-guarded (other
      spelling), hints reset per call, fallback removed, newline check dropped, init query
      narrowed to id/title/status.
- [x] **A tautological assertion deleted** (`doesNotMatch(/callApi\([^)]*invocable/)` — no such
      call was ever proposed, and it would not have caught one written another way).
- [x] **The operations manual listed a pool the tip might not come from.** Its framing now
      says a tip may also be one of the account's own standards' sentences.
- [x] **The relay instruction was told to translate the phrase the user is supposed to say.**
      It now translates the sentence and keeps a quoted phrase exactly as written.
- [x] `shared/tips.js` threw a bare `TypeError` at import if the anchored tip were renamed —
      loud, but nameless, and it takes the API server down with it since the route imports the
      module. Now an explicit error saying what is missing and why.

Not acted on, with reasoning:

- [x] **"The MCP offline path could derive hints from `cache.data.team_standard`."** It could
      not: that bucket is filled from the init response's `team_standards` field, which only a
      non-compact response carries, and every caller asks for compact. Measured on this
      machine — the cache file has no `team_standard` key at all. The offline path falls back
      to the static pool, and the code now says why.
- [x] **"`id` and `title` in the payload are unread."** True today. They are two short fields
      on a list of five, they make the payload legible when someone is debugging why a tip did
      or did not appear, and dropping them would make the next consumer re-add them. Kept.
- [x] One reviewer noted the intermediate commit was red on `readme-version-sync` — accurate:
      `package.json` moved before the READMEs, in the same branch, one commit apart. CI runs
      the PR head, which is green. Worth avoiding, not worth rewriting history for.
