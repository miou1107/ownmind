# v1.26.128 — Proposal: the team standards the server sends and the hook throws away

## Background

v1.26.127 rewrote the tip list. One tip was cut for overclaiming:

> OwnMind has team standards: everyone's AI follows the same rules automatically, so nobody
> breaks them by accident

Vin wants it back. Checking whether it can be true turned up something larger than the
sentence.

`/api/memory/init` returns `team_standards_digest`, and it is placed **outside** the
`!compact` guard — i.e. deliberately sent on the compact path, which is the path every live
caller uses (`mcp/index.js`, `hooks/lib/conditional-sync.js`, `hooks/ownmind-session-start.sh`
all pass `compact=true`). `hooks/lib/render-session-context.js` never read it.

So a team's standards reached anyone whose tool calls the `ownmind_init` MCP tool, and nobody
whose tool loads memory through the SessionStart hook. Claude Code is entirely in the second
group.

**The uploaded standards were never in front of the AI that was supposed to follow them.**

This is the same shape as the missing tip in v1.26.127, and it hides the same way: the only
visible symptom is an AI that does not follow a rule, which reads as an AI being unreliable
rather than as a rule that was never delivered. Nobody files that as a bug.

## Approach

Render the digest. It goes **after** the iron rules, because iron rules outrank team
standards when the two conflict, and ordering says that without a sentence claiming it.

The digest is titles only (`[團隊] <title>` per line), so the section names how to read one in
full — `ownmind_get("standard_detail")`. Seeing a rule's name without its text is not enough
to obey it.

The section is omitted entirely when the user has no team standards, so a solo user's context
does not grow a heading with nothing under it.

## The tip wording

Two tips return to Vin's preferred phrasing:

- `Say "report an OwnMind bug" to send the problem straight to the administrators`
- `OwnMind has team standards: every member's AI follows the same rules automatically, so
  nobody breaks them by accident`

The second is now delivered rather than asserted. What backs it is the AI following rules it
has been given — the same footing iron rules stand on, since no hook blocks a team-standard
violation either. That is a real limit and it is recorded in the code comment, not hidden.

## What this does not do

It does not add enforcement. `hooks/` contains no reference to `team_standard`; the
pre-commit gate reads iron rules only. Making standards blocking is a separate decision with
its own failure modes, and nothing here pretends otherwise.
