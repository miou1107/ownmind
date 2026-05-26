# v1.26.1 — Bug Report Free-Form Path (Fix `ownmind_report_bug` Design Defect)

## One-Line Summary

`ownmind_report_bug` currently rejects any bug_fingerprint that isn't pre-registered in `shared/bug-fingerprints.js`, so users cannot report newly discovered design issues — the tool only works for problems the developer already anticipated. Add a generic `clt_user_reported_other` fingerprint as the free-form escape hatch, update server error message + MCP tool description + hook stderr messages to surface it.

## Background

Two real-world failures motivate this change:

1. **User tries to report an `init handoff` design issue** → server returns HTTP 400: "bug_fingerprint 必填、且必須是後端註冊過的指紋". The user has no usable fingerprint because no `init_handoff_*` fingerprint exists in the registry. The tool that was designed to capture user-discovered problems can't capture user-discovered problems.

2. **reply-lint hook stderr emits `bug_fingerprint: lint_context_memory_missing, suggest_report: true`** on every block — but that fingerprint is semantically reserved for "the lint *itself* misfired". When the AI/user tries to reuse it to report an unrelated issue (e.g., a handoff design problem), the report lands in the wrong bucket: developers triaging lint misfires would see noise, and the real handoff issue stays invisible.

Root cause: the original design (OpenSpec v1.19.14) assumed every reportable bug fits a known fingerprint. That assumption breaks for the most valuable class of reports — newly discovered design issues.

## In Scope

### 1. Add generic fingerprint

`shared/bug-fingerprints.js`: register `clt_user_reported_other` in the `clt` category.

```js
clt_user_reported_other: {
  category: 'clt',
  description: 'User-initiated free-form report — for design issues / new categories not yet registered as a specific fingerprint.',
},
```

### 2. Server error message: add hint

`src/routes/bug-reports.js:80`:

- Before: `'bug_fingerprint 必填、且必須是後端註冊過的指紋'`
- After: `'bug_fingerprint required and must be a registered fingerprint. If you don\'t have one (e.g. reporting a newly discovered design issue), use "clt_user_reported_other".'`

### 3. MCP tool description: relax + clarify

`mcp/index.js` `ownmind_report_bug` `bug_fingerprint` field description:

- Before: `"Error fingerprint (taken from the error response's suggest_report flag — must NOT be fabricated)"`
- After: `"Error fingerprint. Prefer the value from a server suggest_report response. If reporting a newly discovered design issue with no matching registered fingerprint, use \"clt_user_reported_other\" instead of inventing a name."`

### 4. Hook stderr disambiguation

Both reply-lint and pre-commit hooks emit a `bug_fingerprint: …, suggest_report: true` line to invite reporting. Today the AI sees that line and uses the fingerprint verbatim — even when the issue being reported is unrelated to the hook's own misfire. Add a one-liner clarifying scope:

- `hooks/ownmind-reply-lint.js:288` and `:313` — append: `"(Use this fingerprint only when reporting THIS lint decision as a misfire. For unrelated issues, use bug_fingerprint=clt_user_reported_other instead.)"`
- `hooks/ownmind-git-pre-commit.js:163` — append: `"(Use this fingerprint only when reporting THIS commit block as wrong. For unrelated issues, use bug_fingerprint=clt_user_reported_other instead.)"`

### 5. Tests

- `tests/bug-fingerprints.test.js` — assert `clt_user_reported_other` is registered with category `clt`.
- `tests/bug-report-helpers.test.js` (or new) — confirm `withReportSuggestion` works when fingerprint = `clt_user_reported_other`.
- Existing `tests/migration-016-bug-reports.test.js` — assert POST with `clt_user_reported_other` is accepted (no 400).

## Out of Scope

- ❌ Removing fingerprint enforcement entirely — rate limit + spam detection rely on stable fingerprints for hot buckets. The fix is "add one escape-hatch fingerprint", not "allow any free-form string".
- ❌ Changing spam-detection thresholds — they still work: rule 3 (same-fingerprint 5/h) catches a user spamming `clt_user_reported_other`; rule 1 (similarity) catches content-duplication regardless of fingerprint; rule 2 (24h volume) is fingerprint-agnostic.
- ❌ Backfilling old reports.
- ❌ Auto-categorizing free-form reports (admin can manually triage).

## Design Decisions

### Why one generic fingerprint, not "any string allowed"

The spam-detection rule "≥5 reports of the same fingerprint within 1h" relies on fingerprints being stable buckets. If we let users invent arbitrary fingerprints, an attacker would just rotate the string and bypass the bucket detector. Funneling free-form reports through a single fingerprint preserves that defense — bucket fill rate becomes the natural rate-limit signal for free-form abuse.

### Why category `clt`, not a new category

`clt` already means "client-initiated condition". `clt_invalid_payload` and `clt_missing_required_field` are client-side failures the server reports back; `clt_user_reported_other` extends the family to "client-side user assertion that something is wrong". Same shelf, no new prefix.

### Rate-limit interaction

The interface-layer rate limit "same fingerprint, 3/h → HTTP 429" applies to `clt_user_reported_other` too. That cap is intentional: one user can submit 3 free-form reports per hour, which is plenty for legitimate use and a natural ceiling against AI-loop spam.

### Why update hook stderr (not just server)

The hook stderr message is what the AI literally reads as instruction. If we only register the new fingerprint but leave the stderr saying "bug_fingerprint: lint_context_memory_missing", every AI will continue to copy that string. The disambiguation must live where the AI sees it.

## Acceptance Criteria

- `tests/bug-fingerprints.test.js` includes an assertion that `clt_user_reported_other` is registered.
- `isValidFingerprint('clt_user_reported_other') === true`.
- POSTing a report body with `bug_fingerprint: 'clt_user_reported_other'` is accepted (201), not 400.
- Both hook stderr messages contain the literal string `clt_user_reported_other` and instruct the AI how to use it.
- `npm test` passes (1954+ tests, no regression).
- `package.json` bumped to 1.26.1.
- CHANGELOG.md / FILELIST.md / trilingual READMEs updated.

## Risk

- **Low**: code change is small (one registry entry + four strings).
- **Low**: spam-detection / rate-limit defenses still work (analyzed above).
- **Medium**: if a user uses `clt_user_reported_other` for every report, admin triage becomes harder. Mitigation: title + description still carry signal; admin dashboard can group by similar content (existing `similar_content` cluster detector is already there).

## Rollback

`git revert <commit>` cleanly reverts. No DB changes. The new fingerprint sits in code only.

## Follow-ups (Out of Scope, Document Only)

1. **Admin "promote to specific fingerprint" workflow** — when a `clt_user_reported_other` report turns out to be a recurring class, admin should be able to one-click promote it: register a new fingerprint in `bug-fingerprints.js` and tag historical reports. Not in v1.27 — manual triage is fine for now.
2. **Hint pre-filling in MCP** — the MCP tool could detect "no fingerprint provided" and pre-fill `clt_user_reported_other` automatically, reducing AI confusion. Considered for v1.28 once we observe how the new path is actually used.
3. **Multi-bucket rate limit** — once `clt_user_reported_other` becomes the hot bucket, a per-category rate limit (rather than per-fingerprint) may be worth adding.
