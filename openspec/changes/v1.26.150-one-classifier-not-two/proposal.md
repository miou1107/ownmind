# One classifier, not two

## Why

v1.26.149 made the two command classifiers agree. It did not make them one thing, so they
could still be edited apart — and the guard test that catches it only runs when someone runs
it. The remaining question was whether the shell copy still needed to work without node.

It does not, and has not for a long time. `hooks/ownmind-iron-rule-check.sh` calls `node`
more than a dozen times. The first call is near the top of the file, before any of the
classification, and exists only to read a version string out of `package.json`:

```sh
VERSION=$(node -e "…package.json…version…")
```

Credentials, the rule fetch, the payload parse, the verification pass and the output
rendering all go through node as well. A machine without node on `PATH` does not get a
degraded hook; it gets a hook that fails at line 23. So the stated cost of removing the
duplication was already being paid, and the duplication was buying nothing.

That reframes the choice recorded in v1.26.149's tasks.md. Option A (patterns as shared
data both sides read) was only better while the shell copy had to stand alone. It does not,
so A buys a parsing layer for a property that does not exist.

## What changes

- **New `hooks/ownmind-detect-trigger.js`** — reads a command on stdin, prints the trigger
  `detectCommandTrigger()` returns. It is a wrapper, not an implementation.
- **The grep chain in `hooks/ownmind-iron-rule-check.sh` is deleted** and replaced by a pipe
  into that wrapper. The shell hook and the `.js` hook now reach the same function.
- **Both installers gain the new helper** in their hook-file lists.
- **`tests/helpers/hook-home.js`** — one place that stages the throwaway `$HOME` the shell
  hook runs inside, replacing the same block hand-written in five test files.

The command goes in on stdin rather than argv: a `git commit -m` message is routinely
multi-line and stdin has neither the length cap nor the quoting rules argv does. It is also
what every other node call in that hook already does.

Failure is checked, not assumed. The wrapper's exit status is tested and a non-zero status
is written to the activity log, and stderr is deliberately not redirected — an empty answer
from a silently broken classifier is indistinguishable from "this command triggers nothing",
which is the most common true answer and therefore the best hiding place a defect could ask
for.

## What this does not change

The trigger patterns themselves. Every one of the 18 commands in
`tests/iron-rule-trigger-parity.test.js` classifies exactly as it did in v1.26.149. This
change is about where the answer comes from, not what it is.

`TRIGGER_TAG_ALIASES` is still duplicated between `shared/helpers.js` and the banner-building
block inside the shell hook. That is a separate duplication with its own drift test, tracked
as issue #91, and merging it is a different piece of work.

## Impact

- Affected: `hooks/ownmind-iron-rule-check.sh`, `hooks/ownmind-detect-trigger.js` (new),
  `shared/helpers.js` (doc only), `install.sh`, `install.ps1`,
  `tests/helpers/hook-home.js` (new), and the five test files that stage a hook home.
- One extra `node` process per triggered PreToolUse call. Measured against a hook that
  already starts node more than a dozen times, this is noise. Folding the classification
  into the existing payload-parsing node call would avoid it and was rejected: it saves a
  process on the path where the answer is discarded anyway, and it puts two unrelated jobs
  in one block of inline source.
- Nothing user-visible. No rule fires differently than it did in v1.26.149.
