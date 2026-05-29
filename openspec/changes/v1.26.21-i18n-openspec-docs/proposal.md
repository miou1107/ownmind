# v1.26.21 — i18n Track B: openspec docs English-ization

- **Author**: Vin
- **Date**: 2026-05-29
- **Status**: In progress
- **Track**: B (developer-facing internal docs → English)

---

## 1. Why

Per the repo CLAUDE.md dual-track i18n policy, OpenSpec internal dev docs
(proposal / spec / tasks / conventions) belong to Track B and should be in
English so global contributors can read them. A survey found 5549 Chinese
lines across 93 `.md` files under `openspec/`. The bulk (5485 lines / 89 files)
lives in `changes/archive/` (frozen historical snapshots); the living docs are
`CONVENTIONS.md` (54 lines) and a few preserved-on-purpose tokens in active
changes.

Vin chose the full scope: translate CONVENTIONS.md **and** the archive.

## 2. Hard safety boundary — translate prose ONLY

This is documentation, so there is no test that can catch a bad translation.
The audit is a `git diff` review proving only explanatory prose changed.

**TRANSLATE (Chinese → English):**

- Explanatory prose: section bodies, design rationale, motivation, narrative
  describing what/why a past change did.
- Headings that are plain descriptions.
- Table cells that are plain descriptions.

**PRESERVE byte-for-byte (NEVER translate):**

- **Iron-rule content / titles quoted as data** — e.g.
  `# IR-002: 不要 commit .env 或密碼`, rule body text. This is user data
  (CLAUDE.md: 鐵律內容 = user data, not translated).
- **Code-fence content** that represents a product artifact — yaml skill
  bodies, JSON, SQL, sample memory/rule payloads, terminal output samples.
- **Matcher / regex / assertion tokens** — `/^## 起源/`, `[^a-z0-9一-鿿-]`,
  `assert.equal(..., '需要管理員權限')`, `「何時 / 觸發」`, tier labels
  (`TIER_LABEL_ZH`, `條`), section markers a parser re-finds.
- **Quoted user/product strings** — any Chinese that is shown verbatim to an
  end user or stored as data.
- **Personal iron-rule numbers `IR-NNN`** — leave exactly as-is. IR-050
  cleanup is a SEPARATE backlog (memory id 530); do NOT mix it in here.
- **`Author: Vin`, dates, branch/worktree names, version tags.**

**Consequence (expected, not a defect):** many archive files are mostly quoted
rule content, so they will remain substantially Chinese after this change. That
is correct — we only translate the prose wrapper.

## 3. Scope

- `openspec/CONVENTIONS.md` — living conventions doc (highest value).
- `openspec/changes/archive/**/*.md` — 89 files, frozen snapshots, prose only.
- Active `changes/v1.26.*` — leave the ~10 preserved-on-purpose CJK tokens.

## 4. Out of scope

- Any code, test, fixture, or runtime behavior change.
- IR-NNN neutralization (separate backlog, memory id 530).
- Translating quoted iron-rule content or product strings.

## 5. Verification

- `npm test` stays at the 2012 / 0 / 0 baseline (docs do not affect tests; run
  to prove no accidental code touch).
- Per-batch `git diff` audit: every removed Chinese line is explanatory prose;
  no quoted rule content / code-fence / token / IR-NNN changed.
- Quality gates: verification-before-completion + requesting-code-review.
