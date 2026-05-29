# v1.26.0 — i18n Phase 5: Hooks Internal Comments to English (Track B)

## One-Line Summary

Translate all internal JSDoc + line comments in `hooks/*.js` and `hooks/lib/*.js` (537 lines of pure comments) to English, plus 4 small user-facing strings missed by Track A phases. This is the first systematic application of Track B (developer-facing English) per the dual-track i18n policy.

## Background

Phases 1–4 (v1.22 → v1.25) handled Track A: user-facing strings on the server side (MCP descriptions, hook banners, SessionStart UI, reply-lint behavioral prompts, server route messages, INSTRUCTIONS_SOP). The dual-track policy added in CLAUDE.md on 2026-05-26 also calls for Track B — all developer-facing code (comments, dev-only logs, internal identifiers) in English — so the codebase is readable by contributors who don't read Chinese.

`hooks/` is a natural starting point for Track B:

- Small enough (566 Chinese lines across 20 files) to fit one release
- Self-contained (no shared module surface area with `src/`)
- Heavy comment density (94.9% of Chinese lines are pure comments — low risk of behavior change)
- High value: hooks run on every contributor's machine, so the design-decision comments inside them are the first thing a new contributor reads

`src/` (2067 Chinese lines) is deliberately deferred — it mixes comments with user-facing API error messages that still need a Track A compile-time translation system decision.

## In Scope

### Track B (the bulk)

All Chinese in **`hooks/*.js`** and **`hooks/lib/*.js`** of these forms:

- `/** … */` JSDoc blocks (file headers, function docs, design rationale)
- `// …` single-line comments (inline notes, version-tag history, pitfall warnings)
- `/* … */` block comments
- Trailing inline comments after statements (e.g., `const STALE_LOCK_MS = … // 6 小時`)

Each comment translated faithfully — the *reason* the comment exists (often a referenced incident or version-tag like `v1.17.96 review A2`) is preserved verbatim; only the prose is translated.

### Track A patch (small)

Four user-facing string literals missed by phases 1–4:

- `hooks/lib/sync-memory-files.js:84` — `MEMORY.md` auto-sync header line ("由 OwnMind SessionStart hook 自動從雲端同步…")
- `hooks/lib/sync-memory-files.js:85` — `MEMORY.md` edit-via-MCP hint ("需要修改內容？用 ownmind_update…")
- `hooks/lib/sync-memory-files.js:145` — `MEMORY.md` sync-failed warning ("⚠️ Sync failed — 本地記憶可能過期…")
- `hooks/ownmind-verify-trigger.js:66` — `'未命名規則'` fallback when a rule has no title

These are short and have no compile-time translation surface yet — translating now keeps the file 100% English; revisit when the Track A compile-time translation pipeline is wired up.

## Out of Scope

- ❌ **`hooks/ownmind-reply-lint.js:648`** — the Chinese tokens `"白話：…"`, `"即…"`, `"也就是…"` are *functional* (they are the format examples the lint prompt instructs the AI to use when writing Chinese). Keep verbatim.
- ❌ **`src/`** — 2067 Chinese lines, deferred to a later phase with its own compile-time translation strategy decision.
- ❌ **`mcp/`** — 216 lines remaining, mostly comments; will get its own phase or be folded into v1.27+ once `src/` strategy is settled.
- ❌ **`client/`, `shared/`, `scripts/`, `tests/`** — out of scope, separate decisions.
- ❌ Iron rule numbers like `IR-027`, `IR-037` referenced in comments — those are stable identifiers; only the prose around them is translated.

## Design Decisions

### Faithful translation, not paraphrase

Each comment block is translated as-is. Where a comment cross-references a version tag (`v1.17.96 review A2`), an iron rule number (`IR-027`), a file path (`shared/language-lint.js`), or an env var (`OWNMIND_REPLY_LINT_DISABLE`), those tokens stay verbatim. The reason: these comments are forensic — they tell *why* a piece of code looks the way it does, often pointing at a specific past incident. Paraphrasing loses that anchor.

### Trailing inline comments translated in place

`const STALE_LOCK_MS = 6 * 60 * 60 * 1000;  // 6 小時` becomes `const STALE_LOCK_MS = 6 * 60 * 60 * 1000;  // 6 hours`. Two-character savings — keep alignment where it already exists.

### Brand banner preserved

Existing brand banner string templates like `[OwnMind vX.Y.Z]` already use ASCII brackets (changed in v1.22 / v1.25). No further banner work in this phase.

### Track A patch limit

The 4 user-facing string literals are translated *only* because they're short and isolated. We do NOT use this change as the place to design the compile-time translation pipeline — that's a separate decision still pending (`project_482` in OwnMind memory).

### No behavior changes

Comment-only translation cannot change runtime behavior. The 4 user-facing strings have identical semantics in English. No test changes expected unless a test happens to assert against the exact Chinese fallback string `'未命名規則'` — which a grep will catch.

## Acceptance Criteria

- `rg '\p{Han}' hooks/` returns **0 matches** (except the intentional Chinese tokens in `ownmind-reply-lint.js:648` — verified by manual inspection of the diff)
- `node --check` passes for every modified file
- `npm test` passes — green count must match pre-change green count (no regressions, no new tests required)
- `package.json` version bumped to `1.26.0`
- `CHANGELOG.md` v1.26.0 entry added
- `FILELIST.md` reviewed (no new files, so likely unchanged — but verify)
- Trilingual READMEs synced (per IR-131)
- Trailing inline comment alignment preserved (no spurious whitespace shift in diff)

## Risk

- **Low**: 94.9% of changes are pure comment-only edits, runtime-invisible.
- **Low-medium for the 4 Track A strings**: these strings appear in MEMORY.md headers and in lint-failure UI. A test that string-matches against the exact Chinese fallback would fail and surface naturally in `npm test`.

Mitigations:

- Run `rg "未命名規則"` across the codebase before changing the fallback — confirm no other file string-matches the exact phrase.
- Run `rg "由 OwnMind SessionStart hook"` against tests/ to catch any assertion that would break.

## Rollback

`git revert <commit>` cleanly reverts. No DB, state, or schema changes.

## Follow-ups (Out of Scope, Document Only)

1. **`src/` Track B (2067 lines)** — biggest remaining server-side Chinese. Needs a strategy decision: split by route file vs. one big phase? Coordinate with Track A compile-time translation design.
2. **`mcp/` Track B (216 lines)** — small enough to fold into v1.27 or attach to the `src/` phase.
3. **Track A compile-time translation pipeline** — `project_482` still pending. Once decided, the 4 user-facing strings translated here would migrate into the i18n dictionary.
4. **`client/`, `shared/`, `scripts/`, `tests/`** — each needs its own scope decision.
