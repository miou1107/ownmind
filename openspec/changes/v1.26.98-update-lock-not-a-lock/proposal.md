# v1.26.98 — Proposal: `.update-lock` did not lock

## How it surfaced

Not from a bug report. It was found while checking why one user's activity log showed 18
`update_failed` events across six days, which had been read — wrongly — as eighteen failed
upgrades. Pulling the whole time window instead of filtering to failures shows what actually
happens every morning:

```
01:03:24 | update_applied | hook
01:03:23 | update_failed  | hook
01:03:22 | update_failed  | hook
01:03:22 | update_failed  | hook
01:03:21 | update_check   | hook   ×4, same second
```

Four hooks start together, one does the upgrade, three collide and report failure. Same
shape on 08-06 and 08-05. The upgrade succeeded every time; the eighteen were the losing
side of a race being logged as a fault.

## What is actually broken

Three programs run the daily self-update and share `~/.ownmind/.update-lock` so they do not
overlap: `mcp/index.js`, `hooks/ownmind-session-start.js`, `hooks/ownmind-session-start.sh`.
Only the MCP ever took the lock.

**`hooks/ownmind-session-start.sh`** — not a lock, twice over:

```sh
if [ -d "$OWNMIND_DIR/.git" ] && [ ! -f "$LOCK_FILE" ]; then   # line 132
  ...
  ( touch "$LOCK_FILE" || { log_event "update_failed" "step" "lock"; exit 0; }   # line 143
```

The test and the create are ten lines and a `fork` apart, so every concurrent hook passes
the test before the first one creates anything. And `touch` **succeeds on a file that
already exists**, so even a perfectly ordered pair both "acquire". Measured: four concurrent
processes, four winners.

**`hooks/ownmind-session-start.js`** — reads the lock, returns if it is fresh, deletes it if
it is stale, and then creates nothing at all. There is no acquire in that function.

**The stale-lock reclaim, in all three** — `stat` the age, `unlink`, `create`. Two processes
can both see a stale lock, both unlink, and the second one's unlink deletes the fresh lock
the first has just taken. The same bug, one level up.

## Why it matters, given that nothing broke

The consequence today is noise and wasted work. The consequence available on any given
morning is four processes running `git fetch`, `git stash`, `git pull --rebase`,
`npm install` and `update.sh` **in the same working tree at the same time**. One user's
machine has been rolling that die daily. `upgrade_dirty_tree` warnings already appear in the
health broadcasts for two machines, which is the shape a half-finished concurrent pull
leaves behind.

The observability defect is worth as much as the fix. An event named `update_failed` that
fires when nothing failed sent us looking for a fault that did not exist, and would have led
to "fixing" a working upgrade path.

## Approach

One implementation of the protocol, in `shared/update-lock.js`, used by both Node callers.
The shell hook cannot import it — spawning node to take a lock costs more than the lock
saves — so it mirrors the same steps, and the tests run **both** against the same scenarios.

Acquire is `O_CREAT|O_EXCL`: `fs.openSync(file, 'wx')` in Node, `set -C` (noclobber) plus a
`>` redirect in shell. Exactly one process out of any number can succeed, with no window.

Reclaiming a stale lock is serialised behind a second exclusive file, and the winner
re-reads the age before deleting. A lock created while it waited its turn is no longer
stale, so it is left alone and the late reclaimer simply loses its own acquire.

Losing the race is logged as `update_skipped` with reason `lock_held` — the event name and
reason the MCP already uses for this case — not as a failure.

## Not in scope

- The two `upgrade_dirty_tree` warnings. Plausibly caused by this, not demonstrated; a
  causal claim needs the command that produced it.
- Splitting the three copies of the SessionStart hook into one. Backlog 34.
