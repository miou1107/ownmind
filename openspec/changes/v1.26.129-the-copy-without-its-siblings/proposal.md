# v1.26.129 — Proposal: the copy that runs without the folder it imports from

## The regression this release exists to stop

`update.sh` copies `hooks/*.sh` and `hooks/lib/*.js` into `~/.claude/hooks/`. It has never
copied `shared/`. So a lib module that imports `../../shared/…` resolves to
`~/.claude/shared/`, which does not exist, and dies at load with `ERR_MODULE_NOT_FOUND`.

v1.26.127 added `import { getRandomTip } from '../../shared/tips.js'` to
`hooks/lib/render-session-context.js` — the module that produces the SessionStart context.
Anyone who updated to it would open a conversation with **no memories, no iron rules, nothing
at all**. It is on `main` and has not reached a machine yet; this release lands before it can.

## The older bug on the same line

`conditional-sync.js` imports `shared/scanners/base.js`, and the hook invoked it as
`$SCRIPT_DIR/lib/conditional-sync-cli.js` — the copy. Running the installed file fails
outright. Every call site in the hook redirects stderr to `/dev/null`, so the failure
presented as an empty `INIT_DATA`, which the hook treats as a slow API and falls back from.

The conditional sync — the mechanism that skips the download when nothing changed, on ~95% of
sessions — has therefore been doing a full fetch every time, with no symptom anyone could see.

`update.sh` already knew: its usage-scanner block says such files are "kept under
`$OWNMIND_DIR` for execution". The session hook simply never agreed.

## Approach

One `LIB_DIR`, resolved once: the checkout's `hooks/lib` when it exists (where `shared/` is a
sibling), otherwise the copy beside the script. All seven call sites go through it. The
fallback keeps a machine with no checkout behaving exactly as it does today.

The guard reproduces the real layout rather than describing it: copy the modules into a
directory with no `shared/` sibling and assert they fail. A test that only asserted the string
`LIB_DIR` would have passed on the broken tree too.

## Auto-update stops being silent

The daily update already ran on its own and wrote every outcome to the local event log only.
**Success and failure looked identical from the user's side: nothing.** A failing updater is
indistinguishable from an up-to-date machine, and stays that way while it keeps failing.

The work happens in a detached child that outlives the session, so the outcome is not known
during that conversation. `banner-pending.jsonl` already exists for exactly this — whatever is
queued there is printed by the next SessionStart:

- applied → the version, and that there is nothing to do
- failed → which step, in words a user can act on, plus an offer to report it
- clean → nothing at all. Silence has to keep meaning "nothing happened"

The failure message offers to report because the user cannot fix a pull that failed inside a
detached subshell. Surfacing a problem with no way to act on it is just a worry.

## The reminder broadcast becomes a fallback

Its threshold was `${SERVER_VERSION}-prev`: everyone not on the exact newest build. This repo
ships several versions a day and the reminder is mandatory severity, taking over the AI's
first sentence — so nearly every user was told daily to run an upgrade that had already run.
**A notice that fires when nothing is wrong trains people to skip it**, which is how the real
one gets missed.

Now it fires at ten patches behind, and says what that actually means: the automation is not
reaching this machine. It offers a manual retry and, if that fails, the bug report — the one
thing automation cannot do for them.

Vin asked for this fallback to be kept after I proposed dropping it. The case it covers is a
machine whose updates never land and which therefore never receives the failure banner either,
because the banner is written by the update flow.

## What this does not do

It does not make `update.sh` copy `shared/`. Running from the checkout is the smaller change
and matches what that script already does for the usage scanner; duplicating `shared/` into a
second location would be a third copy to keep in sync.
