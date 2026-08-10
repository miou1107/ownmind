# v1.26.127 — Proposal: one tip list, and every tip anchored to something real

## Background

Every MCP tool response has carried a one-line tip since v1.17.7, unconditionally
(`mcp/index.js`, `tip: getRandomTip()`; `tests/tip-every-call.test.js` keeps it that way).
Clients that talk to the API instead of MCP get the same pool inside `INSTRUCTIONS_SOP` in
`src/routes/memory.js`.

Two problems, both invisible until someone diffed the two files.

**The list existed twice, byte-identical.** 28 entries in `mcp/index.js`, the same 28 written
out again as Markdown bullets in `src/routes/memory.js`. Nothing compares them. Byte-identical
is the state a duplicated list is in immediately before it stops being — and the drift would
show up as two different products describing themselves differently to the same user,
depending on whether their tool speaks MCP or REST.

**Some tips described things that were never built.** `Ask "which iron rules are disabled" to
review past decision changes` — no tool retrieves disabled memories; `ownmind_get` has no such
parameter and the API returns disabled rows only on the `since` sync path. `OwnMind keeps
evolving — the AI will proactively suggest workflow and rule improvements` — nothing
implements or instructs that. `Even on online AIs (claude.ai, ChatGPT) you can export and load
your memories` — there is no export path.

**A tip is a claim about the product, phrased in the product's own voice**, prefixed with the
real version banner and delivered on the back of a real operation. Nothing around it marks it
as aspirational, so the user cannot tell the unbacked ones apart, and the cost lands on them:
they go looking for a feature that does not exist.

## Approach

`shared/tips.js` becomes the one list. `mcp/index.js` imports `getRandomTip` from it;
`INSTRUCTIONS_SOP` interpolates `renderTipPool()` instead of restating the bullets. Both
consumers already import from `shared/`, so this needs no packaging change.

Each entry carries an **anchor** — the thing in the repo that makes the claim true:

- `ownmind_*` — a tool name `mcp/index.js` actually registers, or
- `file:<path>` — a repo file backing a capability no single tool call covers (the memory
  files written to disk, the machine/model logging, session compaction).

`tests/tips-list.test.js` resolves every anchor. A tip for a feature that does not exist
cannot be written down without turning the suite red, and a tip whose tool gets renamed fails
at the rename rather than in front of a user.

## What changed in the list

28 entries down to 25.

Four dropped for describing something that does not exist — the three quoted above plus the
2h/50% organize prompt, which *is* instructed but only in two of the six templates, while the
tip reaches every client. Anchoring caught none of that on its own; the audit did.

Four more dropped on a read-through by the person the tips are for, which is the half an
anchor cannot do: it proves the named thing exists, not that the sentence is worth showing.
Out went the ones only someone who works on OwnMind would care about — which machine and
model get logged, that iron rules carry citable codes, how to switch the checks off, how to
list stored secret names.

Four added for everyday moments that had no tip at all: starting the day, wrapping it up,
reporting a bug, team standards. Several others lost their internal phrasing — example
project names, "multi-keyword query", "hand off to Codex" — and the markdown-mirror tip now
says Claude Code and names the three types that actually sync.

## The gap that actually produced invented tips

Vin reported seeing a tip that had nothing to do with OwnMind. A list existing does not mean
the sentence came from it: **the tip rides on MCP tool responses, and loading memory through
the SessionStart hook is not a tool call.** `configs/AGENTS.md` tells the AI to print a tip
immediately after the startup memory load, and nothing on that path ever supplied one. The
instruction was there; the tip was not; the model closed the gap itself.

`hooks/lib/render-session-context.js` now emits one, from the same `shared/tips.js`:

```
Tip (relay this one verbatim; do not compose your own): …
```

An instruction to relay something is only safe where the something exists. The templates get
the other half of that rule — say nothing when no tip was supplied — so the next path someone
adds fails closed instead of improvising.

## The templates

`configs/AGENTS.md`, `GEMINI.md`, `global_rules.md`, `copilot-instructions.md` and
`antigravity.md` said `技巧提示：[隨機一條]` — "a random tip", with no source named. The response
already carries one, so they now say to relay it and forbid composing one. That is a third
list avoided rather than created.

The guard is per tip *line*, not per file: `configs/AGENTS.md` has two tip sites, and a
file-wide check is satisfied by whichever one is still correct while the other quietly reverts.

`configs/CLAUDE.md` has never carried the tip instruction, and does not gain one here.

## What this does not do

Anchoring proves the named tool exists. It does not prove the sentence describes it correctly
— `ownmind_get` is a real anchor for a tip claiming PDF export. Wording stays a review
problem, as it is for every other user-facing string. What it removes is the class where the
named capability was never built at all.
