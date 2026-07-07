# Tasks — v1.26.15 i18n src/ iron-rule family (Track B)

## Safety constraints (apply to EVERY edit in this batch)

- **Identifiers are off-limits.** Translate ONLY comments and string literal
  *content*. Do NOT rename any variable, function, parameter, class, or property.
  Renaming (and missing a reference) is the #1 bug source — excluded entirely
  from this batch.
- **Edit in place, surgically.** Use targeted edits per occurrence; never
  full-file rewrites. Every change must show old vs new.
- **Translate one file, test that file, then move on.** Do not batch all 7 edits
  before testing.
- **Compare pass COUNT, not just "green".** A dropped/skipped test that lowers
  the count is a regression even if nothing is red.
- **`git diff` self-check after each file.** Confirm edits land only on comments
  and string content — no logic, no `${...}` interpolation variables, no structure.

## Phase 0: Baseline

- [ ] Run `npm test` and confirm it is fully green BEFORE any edit (record the
      exact pass count as the baseline — Phase 2 must match it).

## Phase 1: Translate (per file — comments in-scope; messages per proposal scope)

Each file: translate in-scope Chinese to English, leave Out-of-Scope Chinese
untouched, then run that file's test(s) if any.

- [ ] `iron-rule-quality.js` — comments + `errors.push`/`warnings.push`/YAML
      warning text. PRESERVE regex keyword sets (L146/157/221/227/229) and
      `contextPhrases` (L233). Keep Chinese keywords quoted as examples inside
      messages.
- [ ] `iron-rule-frontmatter.js` — comments + 3 `parseError` strings.
- [ ] `iron-rule-tier-validator.js` — comments + 3 `error` strings.
- [ ] `iron-rule-suggest.js` — comments + `notes.push` hints. PRESERVE L146 rule
      body template.
- [ ] `iron-rule-origin-context.js` — comments + plain `error` strings only.
      PRESERVE `renderOriginContextSection` output and the `/^## 起源/` matcher.
- [ ] `iron-rule-sync.js` — comments only. PRESERVE L78 CJK range and the
      aggregate-file content strings.
- [ ] `iron-rule-digest.js` — comments only. PRESERVE `TIER_LABEL_ZH` and tier
      section text.

## Phase 2: Verify

- [ ] Run full `npm test`. Must match the Phase 0 baseline (green).
- [ ] If any test went red on a Chinese substring we translated: update that
      assertion to the new English string, re-run, confirm green.
- [ ] Scan the 7 files: confirm only intended Out-of-Scope Chinese remains
      (`perl -CSD -ne 'print if /\p{Han}/'`).

## Phase 3: Quality gates (mandatory)

- [ ] `superpowers:verification-before-completion` — evidence: test output green.
- [ ] `superpowers:requesting-code-review` — dispatch reviewer on the diff.
- [ ] `superpowers:receiving-code-review` — act on findings.

## Phase 4: Release

- [ ] Sync version in all three places: root `package.json` 1.26.14 → 1.26.15,
      add `CHANGELOG.md` entry, prepare git tag `v1.26.15`.
- [ ] Update README/FILELIST if file inventory changed (it should not — no files
      added/removed).
- [ ] Commit (no Co-Authored-By). Tag `v1.26.15`.
- [ ] `git mv` this proposal dir into `openspec/changes/archive/` once released.
