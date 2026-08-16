#!/bin/bash
#
# Run a test file from a checkout shaped the way CI shapes one on a pull_request.
#
# `actions/checkout@v4` produces two properties a developer's own working copy never has,
# and both of them broke tests/install-clean-machine.e2e.mjs, one after the other:
#
#   - **detached HEAD with no local branch** (the merge ref is checked out by SHA). A clone
#     of that is detached too, so `git pull` inside it exits 1 with "you are not currently
#     on a branch".
#   - **depth 1**. Pushing that history into a fresh repository is refused outright:
#     `! [remote rejected] HEAD -> main (shallow update not allowed)`.
#
# Both were green on `push` and on `workflow_dispatch` and red only on `pull_request` — main
# stays green while every PR fails, which is the shape most likely to end with somebody
# marking the job non-blocking. The second one was found by opening the PR; this script
# exists so the next one is found before that.
#
# Usage: bash scripts/sim-pr-checkout.sh [test-file ...]
#        defaults to tests/install-clean-machine.e2e.mjs
#
# The simulated checkout is left in place afterwards for inspection; its path is printed.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIM="${TMPDIR:-/tmp}/ownmind-sim-pr-checkout"
TESTS=("$@")
[ ${#TESTS[@]} -eq 0 ] && TESTS=("tests/install-clean-machine.e2e.mjs")

rm -rf "$SIM"

# `file://` forces a real fetch rather than a local hardlink clone, which is what makes
# --depth actually produce a shallow repository.
if ! git clone -q --depth 1 --no-hardlinks "file://$REPO_ROOT" "$SIM"; then
  echo "could not clone $REPO_ROOT" >&2
  exit 1
fi

BRANCH=$(git -C "$SIM" branch --show-current)
git -C "$SIM" checkout -q --detach HEAD
[ -n "$BRANCH" ] && git -C "$SIM" branch -D "$BRANCH" -q

# A shallow clone carries committed state only, and the point of running a test here is to
# run it against the edit in front of you. Copy the tracked working-tree files over.
git -C "$REPO_ROOT" ls-files -z | while IFS= read -r -d '' f; do
  if [ -f "$REPO_ROOT/$f" ]; then
    mkdir -p "$SIM/$(dirname "$f")"
    cp "$REPO_ROOT/$f" "$SIM/$f"
  fi
done

echo "simulated checkout: $SIM"
echo "  shallow:  $([ -f "$SIM/.git/shallow" ] && echo yes || echo 'NO - the simulation is wrong')"
echo "  branches: [$(git -C "$SIM" branch | tr -d '\n')]"
echo

cd "$SIM" || exit 1
node --test --test-timeout=900000 "${TESTS[@]}"
