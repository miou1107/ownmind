# v1.25.0 — i18n Phase 4: Server-Side Memory Route in English

## One-Line Summary

Translate `src/routes/memory.js` — the biggest server-side user-facing surface — to English. Includes the 288-line INSTRUCTIONS_SOP (AI behavior manual sent on every init), all HTTP error responses, the upgrade prompt, the enforcement alerts section header, the compliance report section, and other user-facing prose. Last milestone of OwnMind's Track A internationalization.

## Background

After v1.22 (MCP descriptions + git hooks + brand banner), v1.23 (SessionStart), and v1.24 (reply-lint behavioral prompts + lint event display names), only `src/routes/memory.js` remained Chinese-heavy.

This file is server-side — its strings are returned in API responses to every connecting client (MCP, hooks, dashboard). Half-translated would be incoherent, so this change does it as one phase.

The biggest piece is INSTRUCTIONS_SOP — a 288-line behavioral manual sent to AI clients via `/api/memory/init`. It's the manual AI clients read to understand OwnMind's display conventions, iron rule protocol, handoff flow, etc.

## In Scope

- `src/routes/memory.js`:
  - UPDATE_PROMPT constant
  - checkSyncToken error messages (×2)
  - INSTRUCTIONS_SOP template literal (288 lines, the bulk of the change)
  - alertText "Enforcement Alerts" header
  - "Compliance Report (Mandatory)" appended digest section
  - detectedTool fallback string
  - All `res.status(...).json({ error: ... })` Chinese messages (~25 distinct strings)
  - Iron rule lint failure error + hint (×2 places)
  - is_test guard error
  - upgrade message in init response
- Brand banner `【】` → `[]` throughout the SOP

## Out of Scope

- ❌ `logger.warn` / `logger.error` / `logger.info` Chinese messages (~23 occurrences) — Track B (dev environment in English), separate scope.
- ❌ Code comments (Chinese) — Track B.
- ❌ Hardcoded Vin-specific iron rule title in observed_trigger compliance entries (lines 1054, 1421) — user data referenced by product code; flag as design issue for follow-up.

## Design Decisions

### INSTRUCTIONS_SOP — behavioral preservation

The SOP is read by AI clients as their operating manual. Translation MUST preserve:

- All imperative force ("MUST", "MUST NOT", "immediately")
- All format templates `[OwnMind vX.X.X] {type}: {content}`
- All type labels matching the TYPE_MAP in mcp/index.js (Memory loaded / Profile / Iron rule reminder / etc.)
- All TIPS strings matching the TIPS array in mcp/index.js (zero divergence)
- All section headers with their numeric counts (37 categories, etc.)
- The mandatory compliance reporting protocol (comply / skip / violate)
- The 🚨 / ⚠️ / 📌 enforcement tier markers and their handling rules
- The handoff flow (initiator / receiver)
- The disable flow (ask why first → set disabled → record reason)
- The session log format (JSON schema unchanged, just field labels translated)

Type labels intentionally match the MCP TYPE_MAP from v1.22.0, so the brand banner reads consistently across all surfaces.

### TIPS duplication note

The 28 TIPS entries appear in both `mcp/index.js` (TIPS array) and `src/routes/memory.js` (INSTRUCTIONS_SOP). Both are now translated to identical English. A follow-up could deduplicate by importing the array, but not in this change to keep the diff focused.

### Init route compliance test window

`tests/init-compact-compliance-instruction.test.js` extracts up to 800 chars after `ironRulesDigestFinal`. The English version is slightly longer than Chinese, pushing the comply/skip/violate keywords past 800. Test window widened to 1500 chars — the assertion still proves all three actions are present in the digest section.

## Acceptance Criteria

- `rg "[\p{Han}]" src/routes/memory.js` returns only matches inside JS comments (Track B) and inside the two hardcoded user iron rule titles (flagged out-of-scope).
- `rg '【|】' src/routes/memory.js` returns 0 matches in INSTRUCTIONS_SOP.
- `npm test` passes.
- `node --check src/routes/memory.js` syntax OK.
- `package.json` version bumped to `1.25.0`.
- Trilingual READMEs synced.
- `CHANGELOG.md` v1.25.0 entry added.
- `FILELIST.md` updated.

## Risk

- **Medium-high**: INSTRUCTIONS_SOP is the AI's operating manual. A subtly mistranslated imperative could change AI behavior for every OwnMind user.
- Mitigations:
  - All format templates preserved verbatim
  - All imperatives kept ("MUST", "MUST NOT")
  - Type labels match TYPE_MAP from v1.22 (no divergence)
  - TIPS strings identical to mcp/index.js translations
  - Compliance protocol (comply / skip / violate keywords) preserved exactly — verified by existing test

## Rollback

`git revert <commit>` cleanly reverts. No DB or state changes.

## Follow-ups (Out of Scope, Document Only)

1. Track B (dev environment in English): translate the ~23 `logger.*` Chinese strings and all Chinese code comments throughout `src/routes/memory.js`.
2. Hardcoded Vin-specific iron rule title `'學到東西必須全層同步更新'` at lines 1054/1421 is a code smell — product code shouldn't reference a specific user's rule title. Should be replaced with a generic event code or a lookup.
3. TIPS strings duplicated between `mcp/index.js` and `src/routes/memory.js` — deduplicate via shared module.
