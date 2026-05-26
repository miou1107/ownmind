# v1.22.0 — i18n Phase 1: User-Facing Strings in English

## One-Line Summary

Translate all MCP tool descriptions and hook console messages from Chinese to English. First milestone of OwnMind's bilingual-track internationalization push (see `project_498`).

## Background

OwnMind is moving toward a global service. The bilingual internationalization scope was decided 2026-05-26:

- **Track A — Product i18n (user-facing)**: Extends the v1.20 frontend rebuild's "Route C compile-time auto-translation" approach to cover MCP descriptions, hook messages, server errors, and public docs.
- **Track B — Developer environment in English**: Code comments, log/error strings, variable names, internal specs.

This change is the first concrete delivery of Track A. Frontend UI strings already have a translation pipeline (see `v1.20-frontend-rebuild`). The pieces missing are:

1. **MCP tool descriptions** (~75 Chinese strings in `mcp/index.js`) — visible to every AI client that connects to OwnMind. Currently Chinese means non-Chinese-speaking AI agents may misinterpret tool semantics.
2. **Hook console messages** (~9 Chinese strings in `hooks/ownmind-git-*.js`) — surfaced to every user during commit / post-commit. Currently Chinese means non-Chinese users get unreadable diagnostics.

These two surfaces have the largest user-facing impact-to-effort ratio. They are pure text changes, no API contract or behavior change.

## In Scope

- `mcp/index.js` — translate every `description` field in the `TOOLS` array (tool-level + sub-field descriptions), plus all user-facing response strings (offline-mode notices, new-user init, preview notice, etc.).
- `mcp/offline.js` and `mcp/lib/compose-tool-response.js` — translate all user-facing strings.
- `src/routes/memory.js` — translate all user-facing API response strings (the largest surface).
- All hooks emitting terminal output: `ownmind-git-pre-commit.js`, `ownmind-git-post-commit.js`, `ownmind-reply-lint.js`, `ownmind-iron-rule-check.js`, `ownmind-tty-echo.cjs`, `ownmind-session-start.js`, `hooks/lib/render-session-context.js`.
- Replace CJK punctuation 【】 in the OwnMind brand banner with ASCII `[]` across all the above files. Same for any other CJK punctuation (「」／：，。) that appears inside user-facing strings.
- Preserve formatting: emoji prefixes (⚠️), the brand banner structure (`[OwnMind v${VERSION}] <type>`), newlines, template-literal substitutions.
- Preserve semantic warnings: secret-handling guidance in `ownmind_save` / `ownmind_update`, confirm-string protocol in `ownmind_report_bug`.
- Update the three test files that match the brand banner via regex: `tests/mcp-tool-response-shape.test.js`, `tests/reply-lint-hook.test.js`, `tests/ownmind-tty-echo.test.js`.
- Version bump: `1.21.0` → `1.22.0` (minor: user-visible string surface change).
- Sync README trilingual versions (zh-TW / en / ja).

## Out of Scope

- ❌ Server-side `throw new Error("中文")` strings — covered by a later phase, has API contract considerations.
- ❌ Code comments inside `src/` / `hooks/` / `mcp/` — Track B work, separate change.
- ❌ Test fixtures with Chinese user-input simulation — exempt per `project_498` (user-data category).
- ❌ Adding automated lint to prevent re-introduction of Chinese strings — discussed, deferred; project-scoped enforcement design is unresolved.
- ❌ Translating frontend `client/src` strings — already handled by `v1.20-frontend-rebuild` Route C.

## Design Decisions

### Translation source

Translations are written by hand, not LLM-batched, for this phase. Reasons:

- Volume is small enough (~84 strings) that manual quality control beats automation overhead.
- MCP descriptions carry behavioral instructions to AI agents (e.g., "AI must call this tool when…"); auto-translation can subtly distort imperatives.
- Establishes a hand-translated baseline that future LLM translation can be compared against.

### Style guide

- Imperative voice for action verbs ("Save a memory", not "Saves a memory")
- Preserve `⚠️` prefix on safety-critical descriptions
- Preserve all `(optional)` / `(required)` annotations
- Keep examples in original form (`IR-037`, `claude-opus-4-6`, etc.)
- Replace 「」quotes with plain double quotes "..."

### Glossary (terms-to-English)

| 中文 | English |
|---|---|
| 記憶 | memory |
| 鐵律 | iron rule |
| 個人鐵律 | personal iron rule |
| 鐵律編號 | iron rule code |
| 規範 | standard |
| 交接 | handoff |
| 鉤子 | hook |
| 回話 | response / reply |
| 觸發 | trigger |
| 遵守 | comply |
| 違反 | violate |
| 跳過 | skip |
| 卡控 / 擋下 | block |
| 中英混雜 | mixed Chinese-English |
| 行話 | jargon |
| 嚴重程度 | severity |
| 隱私 | privacy |
| 個資遮蔽 | PII masking |
| 上傳階段 | upload stage |
| 切分 | chunk / split |
| 變動統計 | diff stats |
| 對話脈絡 | conversation context |
| 對話輪數 | conversation turn count |
| 痛點 | friction point |
| 工作 session | work session |
| 暫時關閉 | temporarily disable |
| 重新開啟 | re-enable |

### Failure-mode preservation

The hook messages contain operational guidance ("→ run: git tag v1.22.0", "→ use /ownmind-on to re-enable"). Translations must keep these actionable.

## Acceptance Criteria

- `rg '[\p{Han}]' mcp/index.js` returns 0 matches (or only in code comments — track B scope, not blocking this change).
- `rg 'console\.(log|error|warn).*[\p{Han}]' hooks/ownmind-git-*.js` returns 0 matches.
- `npm test` passes.
- MCP server starts successfully (`node mcp/index.js` doesn't throw).
- Manual smoke: a fresh MCP tool listing in Claude Code shows English descriptions.
- `package.json` version updated to `1.22.0`.
- `CHANGELOG.md` has a v1.22.0 entry.
- `FILELIST.md` reflects modifications (no new files, but content changed).
- `README.md`, `docs/README.zh-TW.md`, `docs/README.ja.md` version badges updated.

## Risk

- **Low**: pure string changes, no behavior change, no API change, no DB migration.
- **One sharp edge**: `ownmind_save` and `ownmind_update` descriptions contain instructions to AI ("AI should also pass origin_event / user_quote…"). Translation must preserve the imperative force so AI agents continue filling those fields.
- **One sharp edge**: `ownmind_report_bug` description contains a strict protocol ("AI must NOT auto-fill confirm_string"). Translation must keep that injunction crystal clear, otherwise AI will start auto-filling and the feature will break.

## Rollback

`git revert <commit>` cleanly reverts. No state-altering changes.
