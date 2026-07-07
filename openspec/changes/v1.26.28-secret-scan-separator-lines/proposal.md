# v1.26.28 — Secret scan: stop flagging punctuation-only separator lines + show matched text in block message

## One-Line Summary

Fix a user-reported bug (bug-report id=6, 2026-07-07): a funpass analysis-repo
commit was blocked by the pre-commit secret scan even though it contained no
hardcoded credentials. The actual trigger was horizontal-rule separator lines
(e.g. 66 dashes), which `heuristic:long_alnum` treated as key-like. A second
defect made the incident worse: the block message hid WHICH text matched, so
the reporter misdiagnosed the cause as env-var references.

## Bug Report

- Report id=6, fingerprint `mem_blocked_secret_regex`, client v1.26.27.
- Claim: lines like `env['DATAFORSEO_PASSWORD']`, `Authorization Basic`,
  `c.client_secret` were flagged despite containing only variable references.
- Workaround used: `git commit --no-verify` after manual verification.

## Root Cause

Re-ran `detectSecretLike(line, { skip_keyword: true })` over all 39,031 added
lines of the blocked commit (`ef2ab40` in the funpass repo):

- The lines quoted in the report do NOT match — with `skip_keyword: true`,
  keyword/assignment detection is skipped and none of the regexes fire.
- The only hits were **punctuation-only separator lines** (`-` × 54–66),
  flagged by `heuristic:long_alnum`: length ≥ 20, no CJK, and `-` is in the
  heuristic charset `[A-Za-z0-9\-_+/=.]`.
- The reporter guessed wrong because the pre-commit block message printed only
  `file: reason (detected_by=rule)` without the matched fragment — the
  detector already returns `matched_text` (≤ 80 chars, since v1.19.13), but
  the hook discarded it.

## Fix

1. `shared/secret-detect.js` — new negative condition for the length
   heuristic: `PUNCTUATION_ONLY_REGEX = /^[-_+/=.]+$/`. A value with zero
   alphanumeric characters has nothing key-like about it (JWT / AWS / GitHub
   PAT / OpenAI keys are alnum-dominant), so this introduces no false
   negatives. Mirrors the existing dot-path (v1.19.13) and slash-path
   (v1.26.8) exclusions.
2. `hooks/ownmind-git-pre-commit.js` — the block message now appends
   ` matched="<fragment>"` using the detector's `matched_text`, so users can
   locate the exact offending line instead of guessing. Per code review:
   `regex:*` hits (known real-key formats, very likely actual secrets) are
   masked as `head(8)…tail(4)` so a caught key never lands in the terminal /
   transcript / a cloud bug report in full; `heuristic:*` hits stay unmasked
   — they are only "key-shaped" and are exactly the fragments users need to
   see to diagnose a false positive.

## Out of Scope

- Bug-report id=5 (iron_rule quality check returns non-actionable errors) —
  server-side memory lint, separate component; the matched-text portion of
  this change addresses the same theme for the pre-commit path only.
- Excluding punctuation-DOMINANT (mixed alnum + punctuation) values — kept
  conservative on purpose; only zero-alnum values are released.

## Verification

- New tests in `tests/secret-detect-unit.test.js` (8 cases): dash / equals /
  underscore / dot / mixed `-=` separator lines → allow; random 20+ alnum,
  dash-padded key-like value, real-format GitHub PAT → still blocked.
- New tests in `tests/pre-commit-secret.test.js` (3 cases): staged file with
  separator lines + env-var reference lines → exit 0; regex hit → stderr shows
  the MASKED fragment and never the full key; heuristic hit → stderr shows the
  full fragment.
- TDD: 11 new tests total; 8 verified RED first (7 initial + 1 masking case
  from code review), 3 are guards that were already green.
- Full suite 2041 pass / 0 fail.
- Real-world replay: re-scanned all 39,031 added lines of the originally
  blocked funpass commit → 0 hits.
