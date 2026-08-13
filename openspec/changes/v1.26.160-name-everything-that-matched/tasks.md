# Tasks

## 1. Establish what was actually happening

- [x] Read the report: the line names team standards and not iron rules
- [x] Find the cause — three callers strip `iron_rule` before handing `names` to the renderer
- [x] Confirm the renderer has no opinion: it lists whatever it is given
- [x] Confirm no test asserts the exclusion, in either direction

The last of those is the finding. Three lines in three files, deletable without a red.

## 2. Reverse it

- [x] `hooks/ownmind-edit-reminder.js` — pass `ctx.names` through
- [x] `hooks/ownmind-iron-rule-check.js` — pass `allNames` through, on every trigger
- [x] `hooks/ownmind-render-context.js` — same, and drop the `commit`/not-`commit` split that
      existed only to carry the exclusion
- [x] `shared/hook-context.js` — the comment described a rule that no longer holds

## 3. The test that was missing

- [x] `tests/names-include-iron-rules.test.js` — a stub server, a staged home, one case per
      caller
- [x] A case asserting the banner still prints the rule, so a later tidy-up cannot delete the
      banner and stay green on the listing alone
- [x] Each case is the first operation of its window — a stale state file would silently test
      the throttled one-line form instead, and pass for the wrong reason

## 4. Verify against the code being replaced

- [x] `git stash` the four source files, run the new test: **3 of 4 fail**
- [x] The one that passes is the banner case, which is behaviour this change does not touch
- [x] Restore, run again: 4 of 4 pass

A test written after a change that passes both before and after it records nothing. This one
was checked.

## 5. Release

- [x] Full suite
- [x] CHANGELOG / FILELIST / three READMEs / package.json
- [x] Commit, tag, push

## What this leaves open

Whether the banner and the listing should merge into one block eventually. They now overlap by
design rather than by accident, which is a better place to have that conversation from than
where it started.
