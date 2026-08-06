# v1.26.87 follow-ups — Tasks

Legend: `[ ]` pending · `[x]` done

## Phase 0 — How each one was found

- [x] The rule-sync defect was found by tripping over it: the cache was deleted and the hook
      re-run to verify an unrelated change, which produced a 2-byte `[]` cache and exit 0
      with no output. Nobody was looking for it.
- [x] Read the endpoint directly rather than inferring: `{ data: [...] }`, 135 rules, 27 of
      them carrying verification conditions.
- [x] Checked every consumer of that endpoint rather than the one in hand. Three exist; one
      had been fixed in v1.19.20 and still carries the comment saying so.
- [x] Confirmed the `.sh` variant is the one referenced by a real installation's
      `settings.json`, so its failure was user-visible in effect and invisible in output.
- [x] Reproduced the `.sh` failure by running its parse against the wrapped shape:
      `TypeError: rules.filter is not a function`.

## Phase 1 — The shared parse and cache rule

- [x] `hooks/lib/iron-rule-sync.js` — `parseIronRulesResponse`, `shouldOverwriteCache`. Pure.
- [x] `hooks/ownmind-git-pre-commit.js` imports both; the cache write is now conditional.
- [x] `hooks/ownmind-iron-rule-check.sh` unwraps the envelope, matching the `.js` sibling.
- [x] Tests use the real production response shape as the fixture, plus source guards so the
      old expression cannot come back and the shared parser cannot be left unused.
- [x] End-to-end proof: delete the cache, run the hook. Before, 0 rules and a 2-byte file;
      after, 27 rules.
- [x] Destructive check: reverted the `.sh` fix from a backup copy and confirmed the covering
      test went red, then restored and confirmed green.

## Phase 2 — Repairing env-only credentials

- [x] `scripts/install-helpers/ensure-key-file.cjs`, modelled on `ensure-session-hook.cjs`:
      temp-file-then-rename, refuses an unparseable or non-object config, honours
      `~/.ownmind/.no-key-file`, returns one of `repaired` / `already_safe` / `opted_out` /
      `no_credentials` / `error`.
- [x] Self-check item mapping those outcomes to pass / warn / fail, so only a failed repair
      reaches a human through this version's alerting.
- [x] All four install/update scripts call it and print the summary, label following the
      exit code.
- [x] Tests run the helper as a real child process with a rebuilt environment, so the
      developer machine's own key cannot turn the "no credentials" case into a different one.
- [x] Destructive checks: each of the four call sites removed once, five helper branches and
      three self-check branches broken once — all confirmed red.
- [x] One mutant initially survived (the "do not copy a URL another file already configures"
      guard); a test was added for the real machine shape that motivated it and the mutation
      re-run red.

## Phase 3 — Invisible characters

- [x] `self-check.cjs`: literal U+FEFF in a regex class replaced with the escape.
- [x] `tests/source-files-are-text.test.js` widened from `src/` to also cover
      `scripts/install-helpers/` and `hooks/`, and a second guard added for literal invisible
      characters.
- [x] Wrote a literal U+FEFF back into `self-check.cjs` from a backup copy and confirmed the
      new guard went red, then restored and confirmed green.
- [x] Caught the same mistake twice while writing this change — a literal U+FEFF typed into
      the guard's own regex, and another into the CHANGELOG. Both replaced with escapes; the
      guard now catches the first case itself.

## Phase 4 — Not done, deliberately

- [ ] `hooks/ownmind-usage-scanner.js` still only logs when it sees `background_safe: false`.
      With the repair running from four installers and from every self-check, reaching that
      branch now means refused-or-opted-out, which is not worth escalating.

## Phase 5 — Verification

- [x] Full suite: 3183 tests, 3181 pass, 0 fail, 2 pre-existing skips.
- [ ] Ask Vin before tagging or deploying.
