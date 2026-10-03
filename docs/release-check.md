# The release check

Before a tag goes out, OwnMind reads the repository and its own records and prints one list
(v1.31.5). One line can block; the rest is for the person to read.

## When it runs

- **In front of `git tag <name>` and `git push --tags`** (and a push that names a tag), from
  the Bash hook OwnMind already installs. `git tag -l` and `git tag -d` are not releases and
  do not trigger it.
- **By hand**, from inside the repository:

```bash
node ~/.ownmind/scripts/release-check.js
```

with `--base origin/main` to name the base branch, `--milestone 2026-10` to pick the cards,
and `--tag v1.2.3` to record the tag on every reviewed card afterwards.

## What it prints

```
Blocking:
  ✗ Branch feat/x is 3 commit(s) behind origin/main. Run: git merge origin/main

For you to read (a reminder, not a check):
  branch feat/x, base origin/main
  last tag v1.2.2, 7 commit(s) since
  cards: 2 reviewed, 1 not yet
    - #15 done (Amiee) — coupon expiry notice
  lessons: 3 from this project since the last tag still waiting on /portal/lessons
  team standards for a release (1), in full:
    ## idaytour 打 tag 前先確認分支沒落後 master
    ...
```

- **Blocking** holds exactly one check: the branch is behind its base. That rule was written
  after it happened (2026-09-11), so the hook denies the tag and says what to run. It compares
  against what is fetched; run `git fetch` first if in doubt.
- **Everything else is a reminder** and says so in its header. Cards come from v1.31.3 (by
  `links.milestone`, or every unfinished card of the project when no milestone is given),
  your own lessons from v1.31.0 on this project, standards are the active team standards
  tagged `trigger:deploy`, `trigger:release`, `deploy` or `release` — printed in full,
  because a title is not a standard.

## When it cannot

- No base branch found (no `origin/HEAD`, or it names a branch that is gone, and neither
  `origin/main` nor `origin/master` exists): reported, never blocking. Pass `--base`.
- Not inside a git repository: nothing to check, nothing blocks, the server is not asked.
- OwnMind server unreachable: the git half still answers; the OwnMind lines say "could not
  ask". A release is never stopped by the server being down.
- Server older than v1.31.3: cards say "no task table yet".

## Recording the tag

`--tag v1.2.3` writes `links.released_in = "v1.2.3"` on every reviewed card of the milestone,
and refuses — naming the cards — while any is not reviewed. That is what makes "which version
fixed this" answerable from a card later.
