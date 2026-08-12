# Tasks

## Done

- [x] Establish whether the shell copy still needs to run without node. It does not — the
      hook calls node near the top of the file for the version string, before any
      classification, and more than a dozen times overall. This is what decided the approach.
- [x] Add `hooks/ownmind-detect-trigger.js` — stdin in, trigger name out, exit 0 either way.
- [x] Replace the grep chain in `hooks/ownmind-iron-rule-check.sh` with a pipe into it,
      checking the exit status and leaving stderr alone.
- [x] Add the helper to `HOOK_JS_FILES` (install.sh) and `$GitHookJsFiles` (install.ps1).
- [x] Rewrite the `KEEP IN SYNC` note on `detectCommandTrigger()` — there is no second copy
      to keep in sync with any more.
- [x] Extract `tests/helpers/hook-home.js` and convert all five test files that stage a
      throwaway `$HOME` for the shell hook.
- [x] Update the parity test's header and failure message: it now guards the plumbing, not a
      second rule list.
- [x] Full suite green apart from the two pre-existing `bare-mount-trailing-slash` failures,
      which need `src/public/dashboard/` — gitignored, built by `scripts/ensure-console-build.js`,
      absent in a fresh clone. Unrelated to this change; no route or middleware was touched.

## Deliberately not done

- **Folding the classification into the existing payload-parsing `node -e` block.** It would
  save one process start, but only on calls that already reach the payload parse, and it
  would put two unrelated jobs inside one block of inline shell-embedded source. The
  standalone file is readable and testable on its own.
- **Merging `TRIGGER_TAG_ALIASES`.** Still duplicated between `shared/helpers.js` and the
  banner block in the shell hook. It has its own drift test and its own issue (#91).
- **A test asserting the two installer lists match.** They are inert on a standard install
  and the third consumer of that list — `tests/helpers/hook-home.js` — is now the one that
  actually matters, and it is exercised by every shell-hook test on every run.

## Follow-up

- Issue #92 can close: the duplication it names is gone and the guard that caught it stays.
- Issue #91 (banner-string duplication) is the remaining copy in this hook.
