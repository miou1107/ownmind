# v1.26.29 — Allow editing memory titles via ownmind_update

## One-Line Summary

Users could edit a memory's content / tags / metadata / tier through the
`ownmind_update` MCP tool, but not its title — the tool schema simply never
exposed a `title` field, even though the server PUT endpoint has supported
title updates all along. Open up title editing end to end, with an
empty-title guard and an audit trail.

## Why

Vin (2026-07-08): "現在 IR 的標題名稱好像不能改，只能改內容，可以改成開放
標題修改嗎" — iron rule titles (and memory titles in general) drift as rules
get refined; forcing a delete-and-recreate to rename loses the rule's id,
code, history and stats.

## Current State

- `PUT /api/memory/:id` already destructures `title`, feeds it into the
  iron-rule lint via `merged.title`, and writes it with
  `SET title = COALESCE($1, title)`. Server-side title editing works today.
- `ownmind_update` (mcp/index.js) neither declares `title` in its
  inputSchema nor forwards it in the request body — the only real blocker.
- The v1.20 Portal UI has no memory edit form; the MCP tool is the sole
  user-facing edit path, so this is a client-only capability gap.

## Fix

1. `mcp/index.js` — add `title` to the `ownmind_update` inputSchema
   (optional string) and forward it in the case handler:
   `if (args.title !== undefined) body.title = args.title;`
2. `src/routes/memory.js` PUT — two hardening additions:
   - Reject `title` that is present but not a non-empty string (400).
     Without this, `title: ""` runs lint against an empty title and records
     a history change while `COALESCE('' || null, title)` silently keeps the
     old title — an inconsistent no-op.
   - Record `title_change: { from, to }` in the memory_history metadata,
     mirroring the existing `tier_change` audit convention, so renames are
     traceable.

## Safety (post code review)

- Iron rule quality lint already runs on the merged (future) title when the
  title changes, so renames cannot dodge quality checks.
- Review I1: exposing titles to clients made the `__upgrade_test__` prefix
  reachable — renaming INTO the prefix would disarm both the iron-rule lint
  and the secret guard in the same PUT. Now rejected with 400 (the upgrade
  helper never renames, so nothing legitimate breaks). Note: the reviewer's
  "test-cleanup would then hard-delete it" leg was overstated — cleanup also
  requires is_test=TRUE, which PUT cannot set; the guard is justified by the
  lint/secret-guard bypass alone.
- Review M2: the secret guard now also runs on title-only changes, since the
  title is part of the keyword haystack for non-narrative types.
- Review M1: titles are stored trimmed, so a trailing-space resend is not a
  phantom rename (history noise + local file slug churn).
- Review M3 (API behavior change): `title: null` used to fall through
  COALESCE as "keep old title"; it now returns 400. No in-repo caller sent
  null.
- Iron rule identity is the `code` column (IR-NNN), not the title — renames
  do not break rule stats, references, or the local file sync (files are
  regenerated from the cloud on each session start; the old-slug file is
  swept by the existing stale-file cleanup).

## Out of Scope

- Admin UI / Portal memory edit forms (no such form exists today).
- Renaming the iron rule `code` itself.

## Verification

- New tests in `tests/memory-title-update.test.js` (8 cases, source-level,
  following the `iron-rule-tier-mcp.test.js` precedent): MCP schema declares
  title (optional), handler forwards it, PUT validates empty/non-string
  title, trim normalization, `__upgrade_test__` rename-to block, secret
  guard on title-only changes, title_change history gated on titleChanged.
  Verified RED first in two rounds (4 initial + 4 from review fixes).
- Full suite 2049 pass / 0 fail; red-green replay (stash impl → 4 fail,
  pop → pass).
- Live check after deploy: rename a real memory via ownmind_update.
