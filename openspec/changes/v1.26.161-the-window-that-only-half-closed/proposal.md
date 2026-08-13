# v1.26.161 — the window that only half closed

## One-Line Summary

The command path's hourly window governs the names inside the counts line and nothing else, so
the ⚠️ rule listing still prints in front of every single command; plus the relayed line has no
formatting instruction, and the edit path's banner is still hard-coded Chinese.

## Background

v1.26.154 gave the command path a window: `hooks/ownmind-render-context.js:84` reads the
per-session, per-trigger state and computes `listing`. That value is then used for exactly one
thing — whether `names` rides along inside the counts line (`:91`).

The separate ⚠️ block at `:126-152` is not gated on it. It prints whenever `rules.length > 0`,
which is every command that matched anything.

Measured on a real session (2026-08-13, v1.26.160): two consecutive `gh issue comment` commands,
one minute apart, each printed the same nine-rule ⚠️ list in full. The second one correctly
withheld the names from the counts line — the window was open and doing its job — and then
printed those same nine rules underneath it anyway.

So the throttle looks like it works when you read the counts line, and does not when you look at
the screen. That is the specific failure this repo keeps rewriting these hooks to avoid: a guard
that reports success while the thing it guards goes past it.

Two smaller things ride along, both from issue #94 and both about the same line of output:

- The relay instruction tells the model to translate the line and preserve the numbers. It says
  nothing about how the line should look, so the model prints it as body text, in the same
  weight as the answer the user actually asked for. Tested in the Claude Code renderer:
  `<sub>` and `<small>` do nothing, inline code takes a theme accent colour and comes out
  *louder*, and blockquote-plus-italic is the one combination that recedes.
- Five strings on the edit path are hard-coded Chinese: the occurrence suffix, the legacy
  throttled line, the banner header, the banner footer, and the state-write failure notice. All
  are Track A surfaces the v1.26.0 hooks i18n pass did not reach (`shared/` was never in its
  scope), so a user working in English or Japanese gets a line half translated by the model and
  half Chinese from the source.

  The occurrence suffix has a second defect on top of the language one: it is appended *after*
  the relay instruction, and that instruction names only the counts and the version tag as
  must-survive. A model following it faithfully drops the occurrence — which is the only thing
  that tells a reader a one-line reminder is a throttle and not a breakage.

## In Scope

- Gate the new-path ⚠️ listing on the same `listing` value that already gates the names.
- Add a formatting instruction to the relay text in `shared/hook-context.js`.
- English source for the five Track A strings on the edit path — **each with a relay instruction
  that reaches it**, which is the half a first pass at this got wrong. Export
  `RELAY_INSTRUCTION` so a caller emitting an English string on its own can carry it.
- Move the occurrence suffix inside the line, via a `suffix` option on `renderHookContextLine`,
  and name the occurrence in the must-survive list.

## Out of Scope

- ❌ **The legacy (`/type/iron_rule`) branch at `ownmind-render-context.js:127-142`.** It is the
  compatibility shim for a server older than v1.26.151 and it has no `counts` to store, so
  giving it a window means inventing state for a path that is on its way out. Left exactly as
  it is, including its Chinese, for the reason already recorded there.

  The edit path's legacy line is a different case and IS changed: it is not a separate branch,
  it is `renderEditReminderLine`, shared with the current path. Leaving it Chinese would mean
  one function returning two languages depending on the server the user happens to be on.
- ❌ **The counts line's own repetition.** v1.26.154 decided one line per operation costs
  nothing worth saving. Unchanged — this proposal narrows what repeats, it does not reopen
  that decision.
- ❌ **Removing the overlap between the names and the banner.** v1.26.160 made that overlap
  deliberate on the owner's instruction. Untouched.
- ❌ **`git tag` / `docker compose build` not classifying on the `.sh` path.** Separate defect,
  tracked in #92.

## Design Decisions

### The window governs the whole listing, not part of it

`listing` already means "this is the once-an-hour full output". Everything long belongs behind
it. The alternative — a second window just for the banner — would let the two drift apart, and
two windows that are supposed to agree are one bug away from disagreeing.

### Formatting goes in the relay instruction, not into the line

The line is data: a version tag, a trigger label, five counts. Wrapping it in `> *…*` at the
source would make the markdown part of the string every caller has to carry, including the
throttled path that appends to it. Telling the model how to present it keeps the string one
thing and the presentation another, and matches how the startup tip already works.

### Chinese out of the three strings, not out of the rule titles

The rule titles are user data and stay in whatever language the user wrote them. What changes is
OwnMind's own words around them.
