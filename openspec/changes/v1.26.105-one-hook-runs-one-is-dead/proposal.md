# v1.26.105 — Proposal: one iron-rule hook ran, the other had been dead for months

## Background

Measured on 2026-08-09, on a Windows machine upgraded to v1.26.102. Two PreToolUse entries
in `~/.claude/settings.json` pointed at the same hook:

| matcher | command | measured |
|---|---|---|
| `Bash` | `node "~/.claude/hooks/ownmind-iron-rule-check.js"` | exit 1, `ERR_MODULE_NOT_FOUND` |
| `Edit\|Write\|MultiEdit\|NotebookEdit` | `node "~/.ownmind/hooks/ownmind-iron-rule-check.js"` | exit 0 |

The two files are byte-identical — same hash. Only the directory differs. The copy under
`~/.claude/hooks` imports `../shared/helpers.js`, and `~/.claude/shared/` is a directory no
installer creates, so node exits before reading the first byte of the payload.

Every Bash command the user ran, the iron-rule check died. Hooks are meant to be silent, so
there was nothing to notice.

## Root cause

v1.26.92 already knew that path was broken and pointed new installs at the checkout. Its
repair condition was:

```js
h.matcher === matcher && h.hooks?.some(hh => hh.command?.includes('ownmind-iron-rule-check'))
```

The broken command **mentions** `ownmind-iron-rule-check`. It satisfied its own repair
condition, so it was never going to be rewritten. The `Edit` entry is correct only because
it was newly added that release — new entries are the only ones that reach the write path.

`install.ps1` carried the comment "Upgrades are the whole population" directly above that
loop — the loop that skipped every upgrade. (Line 460 as of b4d8dae; the block is deleted by
this change.)

## Why no test caught it

Four copies of the same logic lived in `install.ps1`, `install.sh`, `update.ps1` and
`update.sh`. Only the bash one was reachable from CI, and `tests/edit-trigger-reminder.test.js`
reached it by slicing the `node -e` block out of `install.sh` and evaluating the string. The
half that rotted is exactly the half no test could touch.

## Why the install self-check said 6/6

`install-artifacts.cjs` asked whether a copy of the hook exists somewhere under
`~/.claude/hooks`. It does. So the machine reported `install_complete 6/6` while the
registered command could not start.

Reading the registered command is necessary but not sufficient, and on this machine it is
not even the failing half: the two copies are byte-identical, so the registered path **does**
exist. What was absent is `../shared/helpers.js` relative to it — `~/.claude/shared/`, which
no installer creates. An ESM import that cannot resolve kills node before the payload runs.

So the check now asserts both: the registered path, and the module that path imports on its
first line. The header of that file already states that a version number is not evidence of a
completed install. This is the same sentence two levels in — **a copy is not evidence that
the registered one runs, and existing is not evidence that it starts.**

## What this changes

- `scripts/install-helpers/ensure-pretooluse-hooks.cjs` — one implementation, called by all
  four install/upgrade scripts, matching the existing `add-post-tool-use-hook.cjs` /
  `ensure-session-hook.cjs` pattern.
- **A command that differs is rewritten.** Presence is no longer treated as correctness.
- The older copy inside `update.ps1` / `update.sh` goes too — it registered a single matcher,
  compared the whole array, and wrote a bash command on Windows. v1.26.80 fixed that in
  `install.ps1` and left the updaters behind.
- `install-artifacts.cjs` reads the **registered** command out of `settings.json` and checks
  that path, plus a new `iron_rule_hook_deps` artifact for the module that path imports. The
  old candidate list remains as the fallback for a machine with nothing registered yet, and
  the dependency check applies only when a `.js` command is registered — the `.sh` hook
  imports nothing.
- `install.sh` no longer invokes the helper as a bare command substitution. Under `set -eE`
  that carries the helper's exit status and takes the installer down at that line, with the
  captured stderr never printed — the exact combination the top of that file warns produced
  no output at all for four months. Both updaters already guarded it; only install.sh did not.
- BOM tolerance: PowerShell's default `Out-File -Encoding utf8` writes a BOM and `JSON.parse`
  rejects it outright — the repair would have failed on the one platform it exists for.

## Also fixed: every upgrade was taking the destructive branch

`.gitignore` now names the six runtime files the installers and hooks write into the
checkout (`.node-path`, `.git-bash-path`, `.last-mcp-update-check`, `.session-hook-installed`,
`cache/`, `git-hooks/`).

The comment at the top of that file already described the failure — untracked files make
`git status --porcelain` non-empty, interactive-upgrade reads that as a dirty tree and
answers with `git reset --hard` — but the list stopped at `.update-lock*`, so on a real
machine every upgrade still took that branch.

The expensive part is not the overwrite. It is that the warning became noise on every run,
and an edit the user actually made scrolls past inside the same message.

## Scope

PreToolUse iron-rule hook registration, and the artifact check that reports on it. The hook's
own payload is unchanged.

## Impact

Every upgraded install carrying a `~/.claude/hooks` command — which is every install that
predates v1.26.92 and never reinstalled from scratch. On those machines the iron-rule check
has not run on Bash calls at all.
