# v1.26.35 — De-identify hardcoded personal name in user-facing generated output

## One-Line Summary

The SKILL.md generators, the rule-suggestion text, the narrative LLM prompt,
and the client's default layout profile hardcoded the owner's name ("Vin"), so
every OTHER OwnMind user saw someone else's name in their own generated skill
files, reports, and top bar.

## Why

- Multi-user leak of the same shape as the v1.26.32-34 iron-rule-code sweep,
  but on the NAME axis: content generated for user B embedded user A's name.
- Confirmed user-facing: `buildBigSkillMd` writes to every user's
  `~/.claude/skills/ownmind-iron-rules/SKILL.md`; the client `layoutProps`
  feeds `<Layout>` → `TopBar` renders `profile.name` (and its initial as the
  avatar), so the UI showed "Vin" + a "V" avatar for everyone.

## Current State (before)

- `src/utils/iron-rule-sync.js` — `buildBigSkillMd` / `buildReferenceFile`
  embed "Vin's iron rules", "Vin 個人鐵律集合", "Vin can upgrade".
- `src/utils/iron-rule-suggest.js` — generated description "是 Vin 從歷史踩坑
  學來的".
- `src/lib/llm-narrative.js` — the narrative prompt's few-shot example uses the
  real name "Vin".
- `client/src/App.jsx` — default `profile: { name: 'Vin' }`.

These builders receive no user identity, so the correct de-identified form is
generic second-person ("your iron rules" / "你的"), and prompt examples use a
placeholder name.

## Fix

- Generated output → generic second-person ("your iron rules",
  "你的個人鐵律集合", "是你從歷史踩坑學來的", "you can upgrade").
- Narrative prompt example name "Vin" → "Alice" (the file's existing
  Alice/Bob/Dana placeholder convention).
- Client default profile name → "User".
- New TDD guard `tests/no-hardcoded-names-in-output.test.js`: each generator's
  output (and the client default) must contain no `\bVin\b`.

## Non-Goals

- **Dev comments** that reference "Vin" as project history ("Vin's spec",
  "Vin raised this need") are left as-is: they are accurate, developer-facing,
  and not shown to users — not a multi-user leak.
- `mcp/package.json` `author: "Vin (miou1107)"` — legitimate authorship, kept.

## Release / Deploy note

Batched with v1.26.32-34 into one tag + deploy. The dashboard's built bundle
(gitignored) still carries the old value until `vite build` runs, so the
running UI drops "Vin" only after the client is rebuilt at deploy time — the
deploy already rebuilds the dashboard.
