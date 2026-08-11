# v1.26.141 — Tasks

## 1. Find out what actually happens

- [x] Simulate a colleague's machine: session context only, no local skill, real user wording
- [x] Confirm both assistants find the standard by title and both reach for the broken lookup
- [x] Prove the lookup is broken against production:
      `ownmind_get({type:'standard_detail', parent_id:869})` → `{"data": []}`
- [x] Confirm `ownmind_search("發 pages")` returns it as the first row
- [x] Confirm the context never mentions searching
- [x] Confirm project memories are absent from the context — `kkvin` appears 0 times in 18 KB

## 2. The three lines

- [x] Standards list: resolve the title with `ownmind_search`, then `ownmind_get({ id })`
- [x] Unrecognised internal term → search before answering; scoped, not every message
- [x] Never claim to have no information about the user's own things without searching first
- [x] Same three in `INSTRUCTIONS_SOP`, for the tools that do not use the SessionStart hook
      (IR-022)

## 3. Tests

- [x] 13 cases over both delivery paths
- [x] Mutation-checked: reverting the standards line kills 3, dropping the term line kills 1,
      dropping the ignorance line kills 2, dropping the server-side section kills 3
- [x] Tighten the two standards assertions to the standards block — they passed on the
      standing instructions further down until scoped

## 4. Verify it changes behaviour, not just the text

- [x] Re-run 「幫我看一下 kkvin.com 那台的部署狀況」 → searches first, quotes the new line
- [x] Re-run 「放到公司 pages」 → searches rather than improvising
- [x] Record that the second run was contaminated by a skill visible in its own environment,
      so only the first is clean evidence

## 5. Release

- [x] `package.json` → 1.26.141
- [x] README × 3
- [x] CHANGELOG
- [x] FILELIST
- [ ] Full suite green
- [ ] Code review
- [ ] Deploy — Vin decides

## 6. Review round

- [x] `INSTRUCTIONS_SOP` rides on `instructions`, which `compact=true` strips — every caller
      asks for compact, so the "both ends" half of this change reached nobody
- [x] Move the rules to surfaces that survive: the `ownmind_search` / `ownmind_get` tool
      descriptions (every tool, every turn) and all seven `configs/*.md` templates
- [x] `ownmind_get`'s own description still said to use `standard_detail` — a tool
      description outranks the session context, being present on every turn
- [x] The Team Standard RAG section of the SOP contradicted the new rule; fixed
- [x] Tests now assert that every `ownmind_*` name in the guidance exists in the tool list —
      the old ones passed against `ownmind_search_standards({ uuid })`
- [x] Measured the reviewer's claim that the `[團隊] ` prefix breaks the search: it does not.
      `[團隊] 發布網頁到 pages.fontrip.com`, `公司 pages` and `kkvin.com` all resolve
- [x] Version numbers out of AI-facing headings
- [x] "No payload grows" corrected — it grows by 621 bytes on a minimal fixture

## 7. Delivery into the user's own files

- [x] Find that `install.sh` / `install.ps1` skip CLAUDE.md forever once "OwnMind" appears,
      and that neither update script touches it — every machine frozen on its install date
- [x] `configs/ownmind-rules-block.md` as the single source
- [x] `scripts/install-helpers/sync-rules-block.cjs` — one implementation for all platforms
- [x] Wire all four scripts: install.sh, install.ps1, update.sh, update.ps1
- [x] Migrate the old unmarked block, exact line match only; leave hand-edited ones and say so
- [x] 14 behavioural tests, including run-twice-is-a-no-op and non-ASCII round-trip
- [x] PowerShell layer exercised in a container: success and failure paths, under StrictMode
- [x] Caught `$args` (a PowerShell automatic variable) in my own new code while testing it
- [x] Remove the earlier Chinese rules from `configs/*.md` — superseded, and a copy per
      template is a copy that drifts
- [x] Align the wording across all three surfaces so they read as one rule

## Left open

- [ ] Windows PowerShell 5.1 is not covered by any test here: the container is pwsh 7, and
      Windows CI runs pwsh 7 with continue-on-error. The empty-file bug v1.26.140 fixed
      happened only on 5.1.
- [ ] `install.sh` still freezes `GEMINI.md` the same way. Upgrades fix it; fresh installs
      write a stale template first.
- [ ] Project memory titles are still not in the session context. Adding them costs ~5.8 KB
      per session against an 18 KB context. Vin's call, not a correctness question.
