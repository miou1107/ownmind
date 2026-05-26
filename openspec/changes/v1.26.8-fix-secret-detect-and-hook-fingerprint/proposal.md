# v1.26.8 — Fix secret-detect path false-positive + pre-commit hook fingerprint dispatch

## One-Line Summary

Two related fixes that both surfaced from the v1.26.7 release flow:
1. `shared/secret-detect.js` heuristic mis-flags `/`-separated file paths
   (like `openspec/changes/v1.26.7-hotfix-msys-path/proposal.md`) as secrets,
   because the heuristic only excludes dotted identifiers, not slash-separated paths.
2. `hooks/ownmind-git-pre-commit.js` always emits the placeholder fingerprint
   `mem_iron_rule_blocking_commit_no_fingerprint` regardless of which rule
   blocked the commit, so users cannot file a bug report when prod's
   fingerprint registry has not yet synced to the latest version.

## Bug 1: secret-detect heuristic over-blocks file paths

### Reproduction (Vin reported via bug-report id=4, 2026-05-26)

```js
detectSecretLike('openspec/changes/v1.26.7-hotfix-msys-path/proposal.md',
                 { skip_keyword: true });
// → { detected: true, rule: 'heuristic:long_alnum',
//     reason: 'value 為 ≥20 字純英數字、看起來像 key / token' }
```

### Root cause

`shared/secret-detect.js:148-159`:

```js
if (
  value.length >= 20 &&
  !CJK_REGEX.test(value) &&
  LONG_ALNUM_REGEX.test(value) &&
  !DOT_SEPARATED_IDENTIFIER_REGEX.test(value)  // ← only excludes a.b.c
) {
  return { detected: true, rule: 'heuristic:long_alnum', ... };
}
```

- `LONG_ALNUM_REGEX = /^[A-Za-z0-9\-_+/=.]+$/` accepts `/` and `.`
- `DOT_SEPARATED_IDENTIFIER_REGEX` only excludes 3+ segment dotted identifiers
- No equivalent exclusion for slash-separated paths

So any ≥ 20 char ASCII path with no CJK and no whitespace lands in the heuristic.

### Impact

- `openspec/changes/v1.26.7-hotfix-msys-path/proposal.md` (file path)
- `src/routes/admin/user-management/audit.js` (deep source path)
- `https://api.example.com/v1/users/12345/profile` (URL)
- `node_modules/@org/package-name/dist/index.js` (npm path)

Any pre-commit message / FILELIST / CHANGELOG that references full openspec
or deep-nested paths gets blocked. v1.26.7 release had to add `— v1.26.7 hotfix 提案`
Chinese descriptions to the FILELIST entries to dodge the heuristic.

### Fix

Add `SLASH_SEPARATED_PATH_REGEX`, mirroring the dot-separated exclusion:

```js
const SLASH_SEPARATED_PATH_REGEX =
  /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+){2,}$/;
```

In the heuristic:

```js
if (
  value.length >= 20 &&
  !CJK_REGEX.test(value) &&
  LONG_ALNUM_REGEX.test(value) &&
  !DOT_SEPARATED_IDENTIFIER_REGEX.test(value) &&
  !SLASH_SEPARATED_PATH_REGEX.test(value)
) { ... }
```

The "3+ segments, each a valid identifier" shape matches real paths but not
random keys (a real key like `ghp_abcdef0123...` has no `/`).

### Tests

- Add cases to `tests/secret-detect-unit.test.js` reproducing the bug
  (3+ segment slash path → allow) and guarding against regressions
  (2-segment slash with otherwise long alnum still hits length heuristic
  because real shortened JWTs land there).

## Bug 2: pre-commit hook always emits placeholder fingerprint

### Root cause

`hooks/ownmind-git-pre-commit.js:165` hard-codes
`bug_fingerprint: mem_iron_rule_blocking_commit_no_fingerprint` in the
error message regardless of which rule blocked.

When the user / AI follows the suggestion and calls `ownmind_report_bug`,
prod's server-side fingerprint registry may not have this entry yet (the
registry is part of `shared/bug-fingerprints.js` which only syncs to prod
after a release). API returns 400 "must be a server-registered fingerprint."

### Fix

Dispatch the fingerprint based on which rule failed:

| Block reason | Fingerprint |
|---|---|
| `IR-002` secret-detect hit (regex / keyword / heuristic) | `mem_blocked_secret_regex` |
| `IR-???` iron-rule quality lint | `mem_blocked_iron_rule_quality` |
| Other (no specific match) | `clt_user_reported_other` |
| Truly unknown (rules without a known category) | `mem_iron_rule_blocking_commit_no_fingerprint` (placeholder, last resort) |

Implementation: `formatBlockMessage` learns about `blockReasons` so it can
choose the most specific registered fingerprint. The placeholder stays as
the final fallback, preserving back-compat.

### Tests

- Add `tests/git-pre-commit-fingerprint.test.js` covering the dispatch logic:
  - secret-detect hit → `mem_blocked_secret_regex`
  - iron-rule quality failure → `mem_blocked_iron_rule_quality`
  - mixed (both fired) → most-specific wins (secret-detect priority)
  - unknown rule → placeholder fallback

## Out of Scope

- Server-side fingerprint registry sync to prod is a deployment task, not
  a code change in this repo; once prod upgrades past v1.26.0 it will pick
  up the new entries automatically.
- `LONG_ALNUM_REGEX` itself is left alone (the existing JWT / AWS / PAT
  detectors that depend on it are still correct).

## Acceptance Criteria

- `npm test` passes (baseline 1980 + new regression tests).
- `package.json` bumped to 1.26.8.
- CHANGELOG.md / FILELIST.md / trilingual READMEs updated.
- `detectSecretLike('openspec/changes/v1.26.7-hotfix-msys-path/proposal.md',
                    { skip_keyword: true })` returns `{ detected: false }`.
- Triggering the hook with a secret-detect hit emits
  `mem_blocked_secret_regex`, not the placeholder.

## Risk

- **Low** — `SLASH_SEPARATED_PATH_REGEX` is a strict negative condition;
  it can only allow more inputs through the heuristic, not block more.
  Real key formats already have dedicated regexes (JWT / AWS / GitHub PAT /
  OpenAI) that run before the heuristic.
- The hook dispatch change preserves the placeholder as a last-resort
  fallback, so any unanticipated rule type still produces a fingerprint.
