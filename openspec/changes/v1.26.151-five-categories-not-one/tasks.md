# Tasks

## Done

- [x] `GET /api/memory/hook-context` — one request, all five categories, filtered server-side.
- [x] `shared/hook-context.js` — the category list and order, the trigger labels, the line
      renderer, and `tallyHookContext`. The tally is pure and separate from the route so the
      decision that matters — which rows count — is testable without a database.
- [x] `ruleMatchesTrigger(rule, trigger, { untaggedMatchesAll })`, defaulting to the existing
      contract; strict only on the five-category path.
- [x] `hooks/ownmind-render-context.js` — the shell hook's renderer, out of inline `node -e`.
      Detects which response shape arrived from the body rather than being told.
- [x] `hooks/lib/hook-context-fetch.js` — the fetch with its fallback, shared by the `.js`
      hook and the edit reminder.
- [x] Both hooks and `ownmind-edit-reminder.js` rewired; `shared/edit-reminder-state.js`
      carries `counts` through the window so the throttled path still makes no request.
- [x] Both installers ship the new helper.
- [x] `tests/hook-context-five-categories.test.js` — renderer, tally, both response shapes,
      and the real `.sh` hook end to end including the fallback and its log record.
- [x] `tests/iron-rule-check-response-shape.test.js` and `tests/iron-rule-trigger-aliases.test.js`
      rewritten. Both used to grep the shell script for source lines that have moved. They now
      run the real modules, and the alias test asserts the **absence** of an inline table
      rather than the agreement of two — a stronger guarantee than the one it replaced.
- [x] Full suite: 4767 tests, 2 failures, both the pre-existing `bare-mount-trailing-slash`
      pair that needs the gitignored `src/public/dashboard/`.

## Decisions taken rather than deferred

- **A 0 count is printed.** The issue flagged this against the edit reminder's silence at
  `rule_count` 0. Reconciled rather than chosen between: that rule is about the total, this
  is about one row inside a listing that already has content. See proposal.md.
- **The how-to line appears only on the infrequent triggers.** The command path has no
  session state to throttle with, and a hint printed before every commit is wallpaper.

## Not done

- **i18n of the category labels.** The issue says to follow "the #91 route". #91 is closed and
  is about splitting `credential` out of `install` and throttling the command path — there is
  no i18n route described anywhere to follow. Labels are Chinese literals in one table in
  `shared/hook-context.js`, which is where a translation layer would attach. Inventing a
  scheme here would have been guessing at a decision that is not mine.
- **Throttling the command path.** Named in #91, still open in substance. The counts line
  reprints on every matching command.

## Follow-up

- **The line does not appear until the server is deployed.** Every client falls back until
  then and prints what it printed before, with `hook_context_fallback` in the activity log —
  which is also how to confirm the deploy landed.
