# v1.26.89 — Tasks

Legend: `[ ]` pending · `[x]` done

## Phase 0 — Check the report rather than adopt it

- [x] Read `matchTemplate`. The reporter's stated mechanism — "a single tag hit" — is wrong:
      a keyword is required too. Confirmed against the real rule that one incidental 測試
      clears the bar, so the conclusion holds even though the mechanism was misdescribed.
- [x] Pulled memory 829's stored text and tags from production and re-ran the match: the
      keyword that fired it is 測試, present once.
- [x] Realised the same mechanism explains the eight rules carrying the docs-staging
      condition, found earlier the same day and wrongly attributed to hand-copying. Without
      this change, removing those by hand would not have kept them removed.
- [x] Checked whether "auto-apply only the non-blocking ones" was available as a middle
      path. It is not: all five templates set `block_on_fail: true`.

## Phase 1 — Stop applying

- [x] `src/routes/memory.js` no longer writes `metadata.verification` on a match.
- [x] The match is still computed and logged, worded so the log does not read as an action.

## Phase 2 — Make the suggestion legible

- [x] `template_suggestion` on the response: name, `applied: false`, `blocks_work`, and a
      sentence the caller can pass straight to the person who wrote the rule.
- [x] `matched_template` kept for existing readers.

## Phase 3 — Guards

- [x] Regression test built from memory 829's real text, asserting the matcher still fires
      on it — kept deliberately, as the standing demonstration of why auto-apply had to go.
- [x] Source guards on the save path: no `UPDATE memories`, no reach into `RULE_TEMPLATES`
      for a payload, no reassignment of `memory.metadata`.
- [x] A test that fails if a non-blocking template is ever added, so the exception gets
      decided rather than assumed.
- [x] Destructive check: restored the old write from a backup copy, confirmed three
      assertions went red, restored and confirmed green.

## Phase 4 — Verification

- [x] Full suite: 3233 tests, 3231 pass, 0 fail, 2 pre-existing skips.
- [ ] Ask before tagging or deploying.

## Phase 5 — Not done

- [ ] No supported way to clear a verification block applied before this change.
      `ownmind_update` works but requires overwriting the whole metadata object and manually
      carrying `origin_context` back — the reporter is right that a normal user cannot do
      that. Recorded in the backlog.
- [ ] No audit of other accounts' rules for templates applied while this was live.
