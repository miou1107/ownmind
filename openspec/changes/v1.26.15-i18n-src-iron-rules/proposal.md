# v1.26.15 — i18n Phase: src/ Iron-Rule Family Internal English (Track B)

## One-Line Summary

Translate internal comments (262 lines) plus pure diagnostic message strings
(~50 lines) in the 7 `src/utils/iron-rule-*.js` files to English. Continuation
of the Track B internal-English effort (v1.26.0/2/3/4/5). Logic-bearing Chinese
and content written into user iron-rule files are explicitly preserved.

## Background

`src/utils/iron-rule-*.js` is the iron-rule processing layer. A scan found 346
Chinese lines across 7 files. Manual inspection split them into three kinds:

1. **Comments (262 lines)** — JSDoc / line comments. Safe to translate.
2. **Logic-bearing Chinese (~10 lines)** — Chinese tokens inside regexes/arrays
   that match the *user's Chinese iron-rule content* (e.g.
   `/規則|該做|不該做|禁止|必須/`, the `contextPhrases` array, the CJK range in
   a slug regex). Translating these breaks matching against Chinese user data.
3. **Display/message strings (~74 lines)** — split further:
   - **Pure messages (~50 lines)**: lint errors/warnings, YAML parse errors,
     tier-validator errors, suggest `notes`. Surface to the AI via API response
     (`memory.js` returns `lintResult.errors`). Translating touches no data.
   - **Content rendered into iron-rule files (~24 lines)**: `injectOriginSection`
     renders a `## 起源` section and later re-finds it via `/^## 起源/` to upsert;
     `iron-rule-sync.js` emits the aggregate SKILL.md; `iron-rule-digest.js` emits
     Chinese tier labels. These are written into / matched against **existing
     stored iron-rule files**.

Decision (user, Track B): translate kinds (1) and (3-pure) to English; do NOT
build a backend i18n dictionary (these strings are read mainly by the AI, which
reads English fine).

## In Scope — translate to English

- All comments (JSDoc + `//`) across the 7 files (~262 lines).
- Pure diagnostic message strings (~50 lines):
  - `iron-rule-quality.js`: `errors.push(...)` / `warnings.push(...)` text, the
    YAML-parse-failure warning. **Keep** any Chinese keyword *quoted as an
    example inside* a message (e.g. a message saying the rule must contain
    `「何時 / 觸發」`) — those examples reference kind-2 logic tokens.
  - `iron-rule-frontmatter.js`: `parseError` strings (3).
  - `iron-rule-tier-validator.js`: `error` strings (3).
  - `iron-rule-suggest.js`: `notes.push(...)` admin hints — EXCEPT the line that
    writes rule body text (see Out of Scope).

Files in scope: `iron-rule-quality.js`, `iron-rule-frontmatter.js`,
`iron-rule-tier-validator.js`, `iron-rule-suggest.js` (notes only),
`iron-rule-origin-context.js` (comments + plain error strings only),
`iron-rule-sync.js` (comments only), `iron-rule-digest.js` (comments only).

## Out of Scope — preserved on purpose

**A. Logic-bearing Chinese (translating breaks behaviour):**
- `iron-rule-quality.js` L146/157/221/227/229 regex keyword sets, L233
  `contextPhrases` array.
- `iron-rule-sync.js` L78 CJK range `[^a-z0-9一-鿿-]` in the slug regex.

**B. Content written into / matched against existing iron-rule files
(translating corrupts stored user data — deferred to a dedicated batch that
also ships a data migration):**
- `iron-rule-origin-context.js`: `renderOriginContextSection` output (`## 起源`,
  `**時間**`, `**信心**`, confidence labels, etc.) AND the paired matcher
  `/^## 起源/` in `injectOriginSection`. These must change together with a
  migration for already-stored rules.
- `iron-rule-suggest.js` L146: the templated rule description written into the
  proposed SKILL.md body.
- `iron-rule-sync.js` aggregate-file content (L115/117/134/136/251/273).
- `iron-rule-digest.js` Chinese tier labels (`TIER_LABEL_ZH`, `條`, section text).

## Verification

- `npm test` (= `lint:zh-only` + `node --test`) MUST stay green. The suite is the
  safety net: any over-translation that breaks Chinese matching or assertions
  turns a test red.
- If a test asserts on a Chinese substring that we translated, the message was
  in-scope: update the test assertion to the English string in the same batch.

## Out-of-scope follow-ups (separate proposals)

- v1.26.16 — `src/` remaining 43 files (Track B).
- v1.26.17 — `tests/` developer-facing Chinese (Track B).
- Track A — backend message i18n + iron-rule-file render migration (kind B above).
