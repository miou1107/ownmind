# Spec — release check

## The git half

GIVEN a repository whose branch is 3 commits behind `origin/main`
WHEN `ownmind release-check` runs
THEN the first section is `Blocking:` and names the count and the base.

GIVEN the branch is not behind
THEN `Blocking:` says nothing is blocking.

GIVEN `origin/HEAD` is unset and both `main` and `master` exist
THEN `main` is the base; `--base master` overrides.

GIVEN no tag exists
THEN "since" is the first commit and the output says so.

## The tag hook

GIVEN the Bash tool is about to run `git tag v1.2.3` and the branch is behind base
WHEN the PreToolUse hook runs
THEN the tool call is denied with the count and the merge instruction.

GIVEN the branch is not behind
THEN the call proceeds and `additionalContext` carries the full check output.

GIVEN the command is `git tag -l` or `git tag -d`
THEN the hook does nothing — listing and deleting are not releasing.

GIVEN the server cannot be reached
THEN the git half still runs; the OwnMind sections each say "could not ask the server".

## The OwnMind half

GIVEN cards 12, 15 in milestone `2026-10` where 12 is `reviewed` and 15 is `done`
WHEN `GET /api/release/check?project=idaytour&milestone=2026-10`
THEN `cards.pending` is `[15]` with its holder, `cards.ready` is `[12]`.

GIVEN sessions on the project since the last tag left 4 lessons, 1 promoted
THEN `lessons.new` is 3.

GIVEN team standards tagged `trigger:deploy`
THEN `standards` carries each one's full text, not its summary.

GIVEN commits since the last tag whose compliance row says `skipped`
THEN `compliance.skipped` lists their short hashes.

## Recording the tag

GIVEN `ownmind release-check --tag v1.2.3 --milestone 2026-10` with every card reviewed
THEN each card's `links.released_in` becomes `v1.2.3`, and the answer lists them.

GIVEN a card is not reviewed
THEN nothing is written and the output says which one.
