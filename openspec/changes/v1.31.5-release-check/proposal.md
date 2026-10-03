# Release check

## Why

Vin's own standard (2026-09-11): before tagging `rc/` or `v` on idaytour, make sure the
branch is not behind master. The team's: three quality steps before a commit, a reproducing
test before a bug fix, verify that a deploy actually landed. Each is a rule the AI is
reminded of; none is a list anyone reads before pressing tag. The moment before a release is
the one time all of them matter at once, and it is answered by memory.

With v1.31.3 the cards of a milestone are in OwnMind, and with v1.31.0 their lessons are. The
release check reads both and the repository, and prints the list.

## What changes

1. **A command, `ownmind release-check [milestone]`**, run from the repository (the `ownmind`
   CLI already exists for install/update). It prints, in this order:
   - the branch, whether it is behind its base (`git rev-list --count HEAD..origin/<base>`),
     and the last tag;
   - cards of the milestone (by `links.milestone` or a `--cards 12,15` list) that are not
     `reviewed`, with who holds them;
   - commits since the last tag whose pre-commit check was skipped or failed (from the
     compliance log the commit hook already writes);
   - lessons from sessions on this project since the last tag that are still `new`;
   - every team standard tagged `trigger:deploy` or `trigger:release`, by title, read in full
     from the server, so the list is the standards and not a summary of them.
2. **A hook on `git tag`.** The git wrapper OwnMind installs (`ownmind-git-passthrough`) does
   not see `tag`; the Bash tool hook does. When the command being run is `git tag` or
   `git push --tags`, the PreToolUse hook runs the release check first and puts its output in
   `additionalContext`. If the branch is behind base, the hook *blocks* with the count and
   the line "run git merge origin/<base> first" — that one is a check, not a reminder,
   because Vin wrote it as a rule after it happened.
3. **A server endpoint** `GET /api/release/check?project=&since=` that answers the OwnMind
   halves (cards, lessons, standards, compliance rows) in one request, so the CLI and the
   hook share it.
4. **The tag that results is recorded on the cards**: `ownmind release-check --tag v1.2.3`
   writes `links.released_in` on every `reviewed` card of the milestone, which is what makes
   "which version fixed this" answerable later.

## Decisions

- **Only the behind-base check blocks.** Everything else is printed. The product rule says a
  reminder must be declared as one; here the declaration is in the output itself: a header
  `Blocking:` with the one check, `For you to read:` with the rest.
- **The base branch is read from the repository**, `origin/HEAD` first, then `main`, then
  `master`; `--base` overrides. Guessing it wrong would block a release for a reason that is
  not real.
- **Works without v1.31.3.** With no cards, that section says "no cards for this project";
  the git and standards halves stand on their own.
- **Fail-open on the server half, fail-closed on the git half.** The server being down must
  not stop a release; the branch being behind must.

## Not in scope

- Running the test suite. The CI does that; the check reads whether CI passed on HEAD when
  the repository has `.gitlab-ci.yml` and the API is reachable with the person's own token,
  and says "could not ask CI" otherwise.
- Deploying. The check is what you read before you tag; it does not tag.
