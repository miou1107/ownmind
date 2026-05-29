# v1.26.4 — i18n Phase 8: shared/ Internal Comments to English (Track B)

## One-Line Summary

Translate all internal JSDoc + line comments in `shared/` (746 lines across 26 files) to English. Continuation of v1.26.0/v1.26.2/v1.26.3.

## In Scope

- `shared/secret-detect.js` (124 lines)
- `shared/language-lint.js` (107)
- `shared/verification.js` (65)
- `shared/privacy-detect.js` (52)
- `shared/bug-fingerprints.js` (48)
- `shared/helpers.js` (29)
- `shared/session-off-state.js` (28)
- `shared/privacy-redact.js` (27)
- `shared/device-fingerprint.js` (27)
- `shared/context-blob-schema.js` (27)
- `shared/scanners/opencode.js` (24)
- `shared/scanners/claude-code.js` (23)
- `shared/lint-event-types.js` (21)
- `shared/scanners/id-helper.js` (20)
- `shared/scanners/codex.js` (19)
- `shared/scanners/base.js` (19)
- `shared/validators/index.js` (15)
- `shared/scanners/vscode-telemetry.js` (15)
- `shared/random-password.js` (13)
- `shared/iron-rule-tier.js` (12)
- `shared/compliance.js` (10)
- 5 small files in `validators/` + `scanners/` (≤7 each)

Note: the user-facing `reason` strings inside `shared/secret-detect.js`
(`'value 符合 ... 格式'`, `'title／description 含關鍵字...'`, `'value 含 ... 賦值樣式...'`)
are intentionally preserved in Chinese. They surface to the AI as guidance to
rewrite Chinese memory content, and `tests/secret-detect-unit.test.js` asserts on
the Chinese substring `'賦值樣式'`. Translating them is left for a dedicated
Track A pass coupled with test updates.

## Out of Scope (Preserved on Purpose)

- `shared/language-lint.js` lines 372 / 381 — AI-facing lint feedback messages
  (`中英混雜比例... 請改成白話中文` / `行話 / 專有名詞沒附白話說明... 「（白話）」「：解釋」「即...」`)
  intentionally Chinese: they instruct AI to write in Chinese; translating to
  English would be self-contradictory and weaken the feedback loop.
- `shared/language-lint.js` line 308 — `/(即|也就是|意思是|簡稱)/` regex used to
  detect Chinese explanation markers in reply text.
- `shared/lint-event-types.js` `EVENT_DISPLAY_NAMES` — already English.
- `shared/privacy-redact.js` `TYPE_LABEL_ZH` — Chinese labels for redaction
  output (`<信箱-001>` etc.). User-facing in redacted text; keep Chinese to
  match the bug-report localized output convention.
- `shared/iron-rule-tier.js` `TIER_LABEL_ZH` — Chinese tier names for digest
  rendering, intentionally bilingual labels.
- `shared/privacy-detect.js` `PRIVACY_TYPE_LABELS` — Chinese banner labels.
- `shared/secret-detect.js` `reason` strings inside `detectSecretLike` —
  intentionally Chinese (see note in "In Scope" above); tests assert on the
  Chinese substring `'賦值樣式'`.
- `shared/helpers.js` `detectTriggerFromContext` — keeps `部署` / `刪除` regex
  fragments to detect Chinese trigger words alongside English ones.

## Acceptance Criteria

- `rg '\p{Han}' shared/` only returns the preserved literals above
- `node --check` passes for every file
- `npm test` passes (same 1956 / 0 baseline)
- `package.json` bumped to 1.26.4

## Risk

- **Low-medium** — pure comment translation + small set of user-facing reason
  strings updated alongside their test assertions.
