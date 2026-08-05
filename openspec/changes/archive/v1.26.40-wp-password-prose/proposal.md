# v1.26.40 — Bug #8: the WP Application Password rule flagged ordinary English prose

## One-Line Summary

`wp_application_password` matched on shape alone — six whitespace-separated
groups of four alphanumerics — which English prose produces readily, so
"hope that this vlog will help" blocked a legitimate commit. The rule now also
requires at least one group that does not look like a plain word.

## Why

Bug report #8 (2026-07-28, medium, component `lint`). Committing scraped social
data was blocked because a Filipino creator's video description read:

> …we successfully had a wonderful 5-day vacation in Taipei. We hope that this
> vlog will help you on your Taiwan Journey.

`hope that this vlog will help` is six consecutive four-letter words, which is
exactly the rule's shape.

### Root cause

`wp_application_password` is the only entry in `SECRET_REGEXES` with **no
identifying prefix**:

| rule | anchor |
|---|---|
| `jwt` | `eyJ` |
| `github_pat` | `gh[opsu]_` |
| `aws_access_key` | `AKIA` |
| `openai_api_key` | `sk-` |
| `ownmind_predefined_key` | `ownmind-` |
| `default_password_literal` | `Password` |
| **`wp_application_password`** | **none — shape only** |

Shape alone therefore has to carry the whole decision, and English collides
with it constantly because four-letter words are common.

This is the rule's **second** false positive of the same kind. v1.19.1
(`ad0104d`) already tightened `{5,}` to `{5}`, with the stated goal "WP
password 改 {5} 恰好 6 組降低誤判". That constrained how many groups match, not
what they are made of, so prose kept matching.

It is also the **third** false positive in this component overall: bug #4 was a
path with `/` read as a secret, and bug #6 was punctuation-only separator lines
caught by `heuristic:long_alnum`. (The #6 reporter blamed
`env['DATAFORSEO_PASSWORD']`; re-running the detector over all 39,031 added
lines disproved that — see
`openspec/changes/archive/2026-07-07-v1.26.28-secret-scan-separator-lines/proposal.md`.)
All three blocked commits that contained no credential — but note that #4 and
#6 came from the length heuristic, not from a regex rule.

### The discriminator

WordPress generates these with `wp_generate_password(24, false)`: 24 characters
drawn at random from upper case, lower case, and digits, displayed as six
groups of four ([Application Passwords integration
guide](https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/),
[`wp_generate_password()`](https://developer.wordpress.org/reference/functions/wp_generate_password/)).

A random draw essentially never yields six groups that all look like plain
words. Prose groups always do. That gap is measurable, so the choice of rule
was made by measurement rather than intuition — four candidates were scored
against 500,000 generated passwords and a prose corpus:

| candidate | missed real passwords (500k draws) | prose still flagged |
|---|---|---|
| at least one digit | 1.4955% | 0 |
| mixed case | 0.0010% | 1 (Title Case) |
| group with digit or non-initial capital | 0.0000% | 1 (ALL CAPS) |
| mixed case AND the above | 0.0012% | 2 |
| **at least one group not word-shaped** | **0 observed** | **0** |

"Word-shaped" means: contains no digit, and is written all lower case, all
upper case, or with an initial capital. Recall matters more than precision for
a security control, so the last option wins.

**Its true miss rate is not zero.** Per group,
`P(word-shaped) = 3·(26/62)^4 = 0.092779`; all six independently gives
**6.378 × 10⁻⁷**, about 1 in 1.57 million. `Abcd efgh Ijkl mnop QRST uvwx` is a
legal draw that the rule misses. Over 500,000 samples the expected number of
misses is 0.32, so observing zero says nothing stronger than "below the
resolution of this measurement". The trade is still clearly right — 6.4e-7
against the digit rule's 1.5% — but a security control's recall has to be
stated honestly, so the derivation now sits in the rule's own comment and the
residual case is pinned by a test.

## Fix

`shared/secret-detect.js`:

- Add `looksLikePlainWord(token)`.
- Give the rule a `confirm(match)` predicate requiring at least one group that
  is not word-shaped. The shape regex stays as the cheap pre-filter.
- Extend the regex loop to honour `confirm`, scanning **every** match rather
  than only the first via `findConfirmedMatch`.

That last point matters more than it looks, and the first attempt got it wrong.

`String.prototype.match` with a non-global regex returns only the first hit, so
`confirm` has to see every match. But iterating with `matchAll` is not enough:
it advances to the **end** of each match, which carves a contiguous run of
four-character tokens into fixed six-token windows and never examines the ones
that straddle a boundary. With five prose words in front of a credential, the
first window is those five plus the credential's first group; skipping to its
end hid the entire credential whenever that first group happened to be
word-shaped. Measured miss rate by number of leading prose words: 0.01% at two,
0.06% at three, 0.90% at four, **8.98% at five**.

That is worse than the behaviour being replaced — the old rule blocked those
commits, noisily and for the wrong reason, but the secret did not get through.
The scan therefore resumes one character past a rejected match's **start**.
Re-measured across 0-7 leading words × 20,000 draws each: 0.000% throughout.

## Non-goals

- No change to the other six regex rules, the keyword pass, or the length
  heuristic.
- The shape regex keeps `\s` rather than narrowing to a literal space. The
  composition check already removes the false positives, and one change at a
  time keeps the cause of any regression unambiguous.
- No allowlist, no per-file exception, no bypass flag. Those move the problem
  rather than fixing it.

## Guard against regression

New `tests/secret-detect-wp-prose.test.js`:

- both known real passwords still detected, including one embedded in text
- 2,000 freshly generated passwords, drawn the way WordPress draws them, all
  detected (the measured miss rate is 0 over 500k; the smaller sample keeps the
  suite fast while still failing loudly if recall regresses)
- the reported sentence, Title Case, ALL CAPS, a plain lowercase run, and a
  line-wrapped run are all cleared
- **prose must not shadow a credential**: a real password appearing after prose
  in the same value is still found, and `matched_text` names the credential
  rather than the prose
- jwt / github_pat / aws_access_key untouched

## What this does not solve

Three of five bug reports filed against this component are false positives from
shape-based matching. This change fixes the WordPress rule properly rather than
adding another exception, but the underlying strategy — decide by shape, with
no notion of context or randomness — is still what the length heuristic and the
remaining rules rely on. A fourth report of this kind is likely. Worth a
dedicated review of the detector's strategy rather than another per-rule patch.

## Release

Patch bump to `v1.26.40`. Deploy to kkvin.com. The hook runs client-side from
`~/.ownmind`, so users also need the client update to get the fix locally.
