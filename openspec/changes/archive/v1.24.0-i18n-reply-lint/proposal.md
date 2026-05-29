# v1.24.0 — i18n Phase 3: reply-lint Surface in English

## One-Line Summary

Translate `hooks/ownmind-reply-lint.js` from Chinese to English. This covers the lint banner shown to the user AND the behavioral prompt fed to Claude when a violation triggers a rewrite. Third milestone of OwnMind's bilingual internationalization.

## Background

v1.22.0 covered MCP descriptions, git hooks, brand banner. v1.23.0 covered SessionStart. The two largest deferred items remain:

- **reply-lint (this change)**: ~30 user-facing strings including a complex behavioral prompt instructing Claude how to rewrite a violating response. Deferred from v1.22.0/v1.23.0 because the prompt's imperative force must be preserved exactly — careless translation can cause Claude to ignore the rewrite instruction.
- **`src/routes/memory.js` (deferred to v1.25.0)**: 28+ server-side API response strings.

## In Scope

- `hooks/ownmind-reply-lint.js`:
  - Session-off terminal reminder
  - Bug-report tip strings (already partially translated in v1.22 in pre-commit; reply-lint has its own copy)
  - `formatBanner` — header, mode messages, downgrade message
  - `formatPrivacySummary` — privacy type labels
  - `formatDowngradeNotice`
  - `_EVENT_DISPLAY_NAMES` — event-to-display-name map (`lint_language_mixed_ratio` → "Mixed Chinese-English", etc.)
  - `formatBlockReason` — the largest piece, a Claude rewrite prompt with imperative force
  - Header / fallback / annotation prose
- `【OwnMind v...】` → `[OwnMind v...]` (consistent with v1.22.0+)
- Tests that assert against the Chinese reply-lint output

## Out of Scope

- ❌ `src/routes/memory.js` — deferred to v1.25.0
- ❌ Logic changes — pure string translation
- ❌ Changing what the lint detects (`shared/validators/*` is separate)

## Design Decisions

### Imperative preservation in `formatBlockReason`

The current prompt instructs Claude to:
1. Rewrite the previous response
2. Fix specific quality issues (with concrete violation words)
3. Annotate the rewrite with a markdown blockquote header
4. Not re-confirm the question — just rewrite directly

The English version must preserve ALL of these. Specifically:

```
↻ 上版違反 X、已被指示重寫（本 session 第 N 次擋下）。
請開頭加一行標註後再寫新回應：
> ↻ 上版違反 X、重新調整。
然後直接重寫、不要重新確認問題。
```

becomes:

```
↻ Previous response violated X — Claude was instructed to rewrite (session block #N).
Add this header line first, then write the new response:
> ↻ Previous violated X, rewriting.
Then rewrite directly — do not re-confirm the question.
```

The "↻" arrow is kept (a visual signal Claude reliably emits in its rewrite).

### Event display names

User-tied event labels:

```
lint_language_mixed_ratio: '中英混雜'
lint_jargon_explanation_required: '行話品質'
privacy_check: '隱私內容'
```

become:

```
lint_language_mixed_ratio: 'Mixed Chinese-English'
lint_jargon_explanation_required: 'Jargon quality'
privacy_check: 'Privacy content'
```

These names appear in the prompt to Claude AND in the banner shown to the user. Translation keeps them consistent across both surfaces.

### Privacy type labels

```
tw_id: '身分證'
email: '電子信箱'
phone_tw_mobile: '手機'
```

become:

```
tw_id: 'Taiwan ID'
email: 'Email'
phone_tw_mobile: 'Mobile phone'
```

"Taiwan ID" preserves locale specificity (the regex matches Taiwan national ID format only).

### Banner header mode messages

The banner shows mode + count info like `（block mode、本 session 累積 3 次、再 1 次就 block）`. English:

`(block mode, session count 3, 1 more violation triggers block)`.

### Big rewrite instructions block

The block reason includes numbered instructions like:

```
1. 用白話中文取代以下英文詞（或在第一次出現時用括號附中文解釋）：
   word1, word2, ...
```

becomes:

```
1. Use plain Chinese to replace the following English terms (or, on first occurrence, add a parenthetical Chinese explanation):
   word1, word2, ...
```

This preserves the rule's intent (Vin wants plain Chinese) while making the imperative clear to Claude.

## Acceptance Criteria

- `rg '[\p{Han}]' hooks/ownmind-reply-lint.js` returns only comment matches.
- `rg '【|】' hooks/ownmind-reply-lint.js` returns 0 matches in non-comment lines.
- `npm test` passes.
- `node --check hooks/ownmind-reply-lint.js` syntax OK.
- `package.json` version bumped to `1.24.0`.
- Trilingual READMEs synced.
- `CHANGELOG.md` v1.24.0 entry added.
- `FILELIST.md` updated.

## Risk

- **Medium** (higher than v1.22/v1.23): the behavioral prompt's imperative force must survive translation. If Claude no longer reliably writes the `↻` annotation header or no longer follows the rewrite directive, the lint loop breaks.
- Mitigations:
  - Translation preserves the `↻` visual cue
  - Translation preserves the explicit "do not re-confirm" directive
  - Tests assert the new English strings appear in the right places
- Behavior-on-this-conversation will be the most authentic real-world test (the lint hook IS firing on my Chinese responses in this session).

## Rollback

`git revert <commit>` cleanly reverts. No DB or state changes.
