# v1.26.22 — repo-wide contributor de-identification (pre-open-source)

- **Author**: Vin
- **Date**: 2026-05-29
- **Status**: In progress
- **Track**: B (pre-open-source de-branding)

## Why

OwnMind is going open-source. v1.26.21 pseudonymized real names only inside
`openspec/` + a few sensitive test fixtures. A code review found real
contributor names still scattered across ~50 files (comments, test
labels/fixtures, CHANGELOG history, design docs). For a public repo, these
real first names should not be exposed.

## Scope

Replace every real contributor name with a consistent pseudonym across the whole
repo (code comments, test labels/fixtures, CHANGELOG, FILELIST, docs/plans).
Also genericize the remaining internal project-name references (FUNIT family).

## Hard rules

- **Pseudonym mapping is NOT recorded in any committed file.** Recording
  "real → alias" anywhere (CHANGELOG, design doc, tasks) would let a reader
  reverse the pseudonymization, defeating the point. The mapping lives only in
  the private task instruction. Files that previously documented the mapping
  (v1.26.21 CHANGELOG entry, the kkvin design doc, v1.26.21 tasks) were rewritten
  to drop the real→alias correspondence.
- **`Vin` is kept** — it is the owner's public handle (author fields, IR-009).
  The longer form of the owner's own name is normalized to that handle.
- Test fixtures are renamed in lockstep (input AND assertion) so behavior is
  unchanged.
- **Left intentionally**: `shared/language-lint.js` proper-noun whitelist of
  internal project codenames (functional allowlist; low exposure) — revisit in
  the kkvin config pass.
- **Out of scope**: local path `/Users/<user>/...` and `.mcp.json` host (those
  belong to the kkvin.com config-extraction pass; `.mcp.json` is functional).

## Verification

- Repo-wide scan for the real names returns **zero** (mapping not recorded).
- `npm test` stays at the 2012 / 0 / 0 baseline (fixtures renamed in lockstep).
- Quality gates: verification-before-completion + requesting/receiving review.
