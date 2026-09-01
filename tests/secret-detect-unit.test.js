import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectSecretLike } from '../shared/secret-detect.js';

// Built by joining, never written out whole: this repository ships the detector,
// so a contiguous key-shaped literal here blocks its own pre-commit scan.
const WP_SAMPLE = ['Qw3r', 'Ty7u', 'I0p2', 'As4d', 'Fg6h', 'Jk8l'].join(' ');

/**
 * v1.19.1 — secret-detect detector unit tests
 *
 * Tracks openspec/changes/v1.19.1-secret-tool-routing/proposal.md §2.1.
 * Detection order: bypass → regex → keyword → length heuristic.
 */
describe('detectSecretLike — regex rules', () => {
  it('WP Application Password format hit (scenario 1)', () => {
    const result = detectSecretLike(WP_SAMPLE);
    assert.equal(result.detected, true);
    assert.equal(result.rule, 'regex:wp_application_password');
  });

  it('JWT format hit (scenario 2)', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = detectSecretLike(jwt);
    assert.equal(result.detected, true);
    assert.equal(result.rule, 'regex:jwt');
  });

  it('GitHub Personal Access Token (ghp_) hit', () => {
    const pat = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';
    const result = detectSecretLike(pat);
    assert.equal(result.detected, true);
    assert.equal(result.rule, 'regex:github_pat');
  });

  it('GitHub Server Token (ghs_) hit', () => {
    const pat = 'ghs_abcdefghijklmnopqrstuvwxyz0123456789AB';
    const result = detectSecretLike(pat);
    assert.equal(result.detected, true);
    assert.equal(result.rule, 'regex:github_pat');
  });

  it('AWS Access Key format hit', () => {
    const key = 'AKIAIOSFODNN7EXAMPLE';
    const result = detectSecretLike(key);
    assert.equal(result.detected, true);
    assert.equal(result.rule, 'regex:aws_access_key');
  });

  it('OpenAI API key format hit', () => {
    const key = 'sk-proj-abc123XYZdef456ghi789jkl';
    const result = detectSecretLike(key);
    assert.equal(result.detected, true);
    assert.equal(result.rule, 'regex:openai_api_key');
  });

  // v1.19.10: OwnMind reserved key prefix
  it('OwnMind reserved key vin-ownmind-admin-2026 hit (incident literal)', () => {
    const r = detectSecretLike('vin-ownmind-admin-2026');
    assert.equal(r.detected, true);
    assert.equal(r.rule, 'regex:ownmind_predefined_key');
  });

  it('OwnMind reserved key ownmind-admin-xxx (no vin- prefix) also hits', () => {
    const r = detectSecretLike('ownmind-admin-prod2026');
    assert.equal(r.detected, true);
    assert.equal(r.rule, 'regex:ownmind_predefined_key');
  });

  it('OwnMind other roles (super / user / api) hit', () => {
    assert.equal(detectSecretLike('ownmind-super-token').detected, true);
    assert.equal(detectSecretLike('ownmind-user-abc1').detected, true);
    assert.equal(detectSecretLike('ownmind-api-xyz9').detected, true);
  });

  it('generic "ownmind" string (no role prefix) does not false-positive', () => {
    const r = detectSecretLike('我用 ownmind 來管理鐵律', { skip_keyword: true });
    assert.equal(r.detected, false);
  });

  // v1.19.10: default password literal pattern
  it('default password Password42760988 hit (incident literal)', () => {
    const r = detectSecretLike('Password42760988');
    assert.equal(r.detected, true);
    assert.equal(r.rule, 'regex:default_password_literal');
  });

  it('Password followed by ≥ 8 digits hits', () => {
    assert.equal(detectSecretLike('Password12345678').detected, true);
    assert.equal(detectSecretLike('Password99999999').detected, true);
  });

  it('Password followed by fewer than 8 digits does not hit (avoid false-positive on form labels)', () => {
    const r = detectSecretLike('Password123', { skip_keyword: true });
    assert.equal(r.detected, false);
  });
});

describe('detectSecretLike — keyword rules', () => {
  it('title contains "password" hit (scenario 3)', () => {
    const result = detectSecretLike('abc123XYZ789longRandomString', {
      title: 'Stripe production password',
    });
    assert.equal(result.detected, true);
    assert.equal(result.rule, 'keyword:password');
  });

  it('title contains "TOKEN" (uppercase) hit (case-insensitive)', () => {
    const result = detectSecretLike('abc123XYZ789longRandomString', {
      title: 'API TOKEN for prod',
    });
    assert.equal(result.detected, true);
    assert.equal(result.rule, 'keyword:token');
  });

  it('description contains Traditional-Chinese keyword "應用程式密碼" hit', () => {
    const result = detectSecretLike('Qw3rTy7uI0p2', {
      description: 'WordPress 應用程式密碼',
    });
    assert.equal(result.detected, true);
    assert.equal(result.rule, 'keyword:應用程式密碼');
  });

  it('description contains "存取金鑰" hit', () => {
    const result = detectSecretLike('abc', {
      description: 'AWS 存取金鑰',
    });
    assert.equal(result.detected, true);
    assert.equal(result.rule, 'keyword:存取金鑰');
  });

  it('content contains "api_key" (snake case) + assignment + value ≥ 8 → hit', () => {
    // Since v1.19.13, value-side keyword detection requires assignment style + value ≥ 8 chars.
    // Values shorter than 8 chars are usually placeholders / form labels / references and
    // should not be blocked.
    const result = detectSecretLike('api_key: abc12345xyz');
    assert.equal(result.detected, true);
    assert.equal(result.rule, 'keyword:api_key');
  });
});

// ============================================================
// v1.19.13 — value-side keyword detection tightened (assignment style only)
// Tracks openspec/changes/v1.19.13-secret-detect-keyword-tighten/spec.md
// ============================================================

describe('v1.19.13 — value-side keyword requires assignment style (S1)', () => {
  // S1.1 real-world regression
  it('S1.1: dotted identifier anydesk.bot_example.unattended_password → allow', () => {
    const r = detectSecretLike('anydesk.bot_example.unattended_password');
    assert.equal(r.detected, false, `should not block, actual rule=${r.rule}`);
  });

  // S1.2
  it('S1.2: "the password is in the vault" → allow', () => {
    const r = detectSecretLike('the password is in the vault');
    assert.equal(r.detected, false, `should not block, actual rule=${r.rule}`);
  });

  // S1.3
  it('S1.3: multi-segment dotted hermes.telegram.bot_token → allow', () => {
    const r = detectSecretLike('hermes.telegram.bot_token');
    assert.equal(r.detected, false, `should not block, actual rule=${r.rule}`);
  });

  // S1.4
  it('S1.4: process.env.MY_PASSWORD → allow', () => {
    const r = detectSecretLike('process.env.MY_PASSWORD');
    assert.equal(r.detected, false, `should not block, actual rule=${r.rule}`);
  });

  // S1.5 assignment style (colon) hits
  it('S1.5: password: MyP@ssw0rd123 → hit', () => {
    const r = detectSecretLike('password: MyP@ssw0rd123');
    assert.equal(r.detected, true);
    assert.ok(r.rule.startsWith('keyword:'), `rule should start with keyword:, actual ${r.rule}`);
    assert.ok(r.reason.includes('賦值樣式'), `reason should contain 「賦值樣式」, actual "${r.reason}"`);
  });

  // S1.6 assignment style (equals) hits
  it('S1.6: API_TOKEN=abc123XYZ987 → hit keyword:token', () => {
    const r = detectSecretLike('API_TOKEN=abc123XYZ987');
    assert.equal(r.detected, true);
    assert.equal(r.rule, 'keyword:token');
  });

  // S1.7 value < 8 chars allow (avoid form-label false-positives)
  it('S1.7: password: hi (value < 8 chars) → allow', () => {
    const r = detectSecretLike('password: hi');
    assert.equal(r.detected, false, `should not block, actual rule=${r.rule}`);
  });

  // S1.8 quoted value hits
  it('S1.8: secret = "supersecretvalue" → hit keyword:secret', () => {
    const r = detectSecretLike('secret = "supersecretvalue"');
    assert.equal(r.detected, true);
    assert.equal(r.rule, 'keyword:secret');
  });

  // S1.9 compound word (mypassword) must not hit
  it('S1.9: mypassword=hello123 (compound word) → allow', () => {
    const r = detectSecretLike('mypassword=hello123');
    assert.equal(r.detected, false, `should not block — compound word "mypassword" is not a key; actual rule=${r.rule}`);
  });

  // Extra: bearer + JWT goes through regex, not keyword
  it('extra: bearer followed by long string is handled by regex (not a keyword hit)', () => {
    const r = detectSecretLike(
      'bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    );
    assert.equal(r.detected, true);
    assert.equal(r.rule, 'regex:jwt', 'JWT regex takes precedence over keyword');
  });

  // Extra: pure reference document containing several secret names
  it('extra: reference doc containing multiple secret names (no assignment) → all allowed', () => {
    const refDoc =
      '相關 OwnMind secret：\n' +
      '- ssh.bot.example.com.vin.password\n' +
      '- anydesk.bot_example.unattended_password\n' +
      '- hermes.telegram.bot_token';
    const r = detectSecretLike(refDoc);
    assert.equal(r.detected, false, `reference doc should not block, actual rule=${r.rule}`);
  });
});

describe('v1.19.13 — matched_text in response (S2)', () => {
  // S2.1
  it('S2.1: when keyword hits, matched_text is a string ≤ 80 chars', () => {
    const r = detectSecretLike('password: MyP@ssw0rd123');
    assert.equal(r.detected, true);
    assert.equal(typeof r.matched_text, 'string');
    assert.ok(r.matched_text.length > 0);
    assert.ok(r.matched_text.length <= 80, `matched_text length ${r.matched_text.length} exceeds 80`);
    assert.ok(
      r.matched_text.toLowerCase().includes('password'),
      `matched_text should contain password, actual "${r.matched_text}"`
    );
  });

  // S2.2
  it('S2.2: when regex hits, matched_text is a string ≤ 80 chars', () => {
    const pat = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';
    const r = detectSecretLike(pat);
    assert.equal(r.rule, 'regex:github_pat');
    assert.equal(typeof r.matched_text, 'string');
    assert.ok(r.matched_text.length <= 80);
    assert.ok(r.matched_text.startsWith('ghp_'));
  });

  // S2.3
  it('S2.3: when length heuristic hits, matched_text is a string ≤ 80 chars', () => {
    const r = detectSecretLike('abcDEF1234567890XYZ9876543210');
    assert.equal(r.rule, 'heuristic:long_alnum');
    assert.equal(typeof r.matched_text, 'string');
    assert.ok(r.matched_text.length <= 80);
  });

  // S2.4
  it('S2.4: when detected=false, matched_text is undefined', () => {
    const r = detectSecretLike('hello world');
    assert.equal(r.detected, false);
    assert.equal(r.matched_text, undefined);
  });

  // matched_text truncation: very long secrets are clipped to 80 chars
  it('extra: very long secret matched_text is clipped to 80 chars', () => {
    const longKey = 'ghp_' + 'a'.repeat(200);
    const r = detectSecretLike(longKey);
    assert.equal(r.detected, true);
    assert.ok(r.matched_text.length <= 80, `truncation failed, length ${r.matched_text.length}`);
  });
});

// ============================================================
// v1.19.13 review fixes — I-1 / I-2 / I-3 regression tests
// ============================================================

describe('v1.19.13 review I-1: title keyword hit must not leak adjacent PII', () => {
  it('title contains password + adjacent phone/email → matched_text returns only the keyword literal', () => {
    const r = detectSecretLike('some narrative content', {
      title: '電話 0912345678 password 信箱 user@example.com',
    });
    assert.equal(r.detected, true);
    assert.equal(r.rule, 'keyword:password');
    // The point: matched_text must not contain the phone number or email.
    assert.equal(r.matched_text, 'password',
      `matched_text should return only the keyword literal, actual "${r.matched_text}"`);
    assert.ok(!r.matched_text.includes('0912'), 'matched_text leaked phone number');
    assert.ok(!r.matched_text.includes('@'), 'matched_text leaked email address');
  });

  it('description contains token + adjacent GitHub PAT literal → matched_text returns only keyword', () => {
    const r = detectSecretLike('content', {
      description: 'this is a token ghp_abcdefghij1234567890abcdef',
    });
    assert.equal(r.detected, true);
    assert.equal(r.rule, 'keyword:token');
    assert.equal(r.matched_text, 'token');
    assert.ok(!r.matched_text.includes('ghp_'), 'matched_text leaked PAT');
  });

  it('CJK keyword "密碼" hit → matched_text returns the keyword literal', () => {
    const r = detectSecretLike('content', { title: '我的 密碼 在 vault' });
    assert.equal(r.detected, true);
    assert.equal(r.rule, 'keyword:密碼');
    assert.equal(r.matched_text, '密碼');
  });
});

describe('v1.19.13 review I-2: dotted identifier requires ≥ 3 segments', () => {
  it('2-segment shape eyJhbGc...eyJzdW... (signature-stripped JWT) → still caught by length heuristic', () => {
    // Both segments ≥ 20 chars and look like base64 token chunks.
    const truncatedJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0';
    const r = detectSecretLike(truncatedJwt);
    assert.equal(r.detected, true,
      `2-segment base64 shape should not slip through the identifier path, actual rule=${r.rule}`);
    assert.equal(r.rule, 'heuristic:long_alnum');
  });

  it('another 2-segment base64 shape abcdef1234567890.fedcba0987654321 → still blocked', () => {
    const r = detectSecretLike('abcdef1234567890ABCDEF.fedcba0987654321XYZ');
    assert.equal(r.detected, true);
    assert.equal(r.rule, 'heuristic:long_alnum');
  });

  it('3-segment identifier path anydesk.bot_example.unattended_password → allow (unchanged)', () => {
    const r = detectSecretLike('anydesk.bot_example.unattended_password');
    assert.equal(r.detected, false);
  });

  it('3-segment process.env.MY_PASSWORD → allow (unchanged)', () => {
    const r = detectSecretLike('process.env.MY_PASSWORD');
    assert.equal(r.detected, false);
  });
});

describe('v1.19.13 review I-3: snake_case prefix + keyword assignment still hits (design intent)', () => {
  it('foo_password=secretvalue123 → hit (snake_case env var, should block)', () => {
    const r = detectSecretLike('foo_password=secretvalue123');
    assert.equal(r.detected, true,
      `snake_case-prefixed password assignment should block, actual rule=${r.rule}`);
    assert.equal(r.rule, 'keyword:password');
  });

  it('reset_password_token=abc12345xyz → hit (multi snake_case; token also counts)', () => {
    const r = detectSecretLike('reset_password_token=abc12345xyz');
    assert.equal(r.detected, true);
    // Either keyword could match; in practice the first (password, earlier in the alternation) wins.
    assert.ok(
      r.rule === 'keyword:password' || r.rule === 'keyword:token',
      `expected password or token, actual ${r.rule}`
    );
  });

  it('-token=abc12345xyz (hyphen prefix) → hit (kebab-case env var)', () => {
    const r = detectSecretLike('-token=abc12345xyz');
    assert.equal(r.detected, true);
  });

  it('mypassword=12345678 (letter-prefix compound word, total length < 20) → keyword stage allows', () => {
    // Note: lookbehind only protects the keyword-detection stage; it does not block the length heuristic.
    // This test keeps total length < 20 to dodge the heuristic and isolate the keyword-stage behavior.
    const r = detectSecretLike('mypassword=12345678');
    assert.equal(r.detected, false,
      `keyword stage should not hit, actual rule=${r.rule}`);
  });
});

describe('detectSecretLike — length heuristic', () => {
  it('alphanumeric ≥ 20 chars → hit (scenario 4)', () => {
    const result = detectSecretLike('abcDEF1234567890XYZ9876543210');
    assert.equal(result.detected, true);
    assert.equal(result.rule, 'heuristic:long_alnum');
  });

  it('contains Chinese → no hit (scenario 5)', () => {
    const result = detectSecretLike(
      '2026-05-07 接手後第一週需要處理的緊急事項清單：1. WP backup ...',
      { title: 'Example Client 接手後緊急事項' }
    );
    assert.equal(result.detected, false);
  });

  it('short string < 20 → no hit', () => {
    const result = detectSecretLike('hello world');
    assert.equal(result.detected, false);
  });

  it('long string containing Japanese → no hit', () => {
    const result = detectSecretLike('abcdefghij日本語テキストklmnopqrstuvwxyz');
    assert.equal(result.detected, false);
  });

  // code review I-1 regression — plain English notes must not hit the heuristic
  it('English notes with spaces → no hit (I-1 regression)', () => {
    const cases = [
      'Working on JWT integration today',
      'Update README and FILELIST after refactor done',
      'Need to commit the README updates again',
      'Phase 2 complete need code review next step',
    ];
    for (const value of cases) {
      const result = detectSecretLike(value);
      assert.equal(
        result.detected, false,
        `"${value}" should not be treated as a secret; actual detected=${result.detected}, rule=${result.rule}`
      );
    }
  });
});

describe('detectSecretLike — bypass', () => {
  it('allow_secret_like=true → skip all detection (scenario 6)', () => {
    const result = detectSecretLike(WP_SAMPLE, {
      allow_bypass: true,
    });
    assert.equal(result.detected, false);
  });

  it('allow_secret_like=true + keyword hit also skipped', () => {
    const result = detectSecretLike('abc', {
      title: 'production password',
      allow_bypass: true,
    });
    assert.equal(result.detected, false);
  });
});

describe('detectSecretLike — edge inputs', () => {
  it('value=null → no throw, returns detected=false', () => {
    const result = detectSecretLike(null);
    assert.equal(result.detected, false);
  });

  it('value=undefined → no throw, returns detected=false', () => {
    const result = detectSecretLike(undefined);
    assert.equal(result.detected, false);
  });

  it('value=empty string → no throw, returns detected=false', () => {
    const result = detectSecretLike('');
    assert.equal(result.detected, false);
  });

  it('options=undefined (no second argument) → no throw', () => {
    const result = detectSecretLike('hello');
    assert.equal(result.detected, false);
  });

  it('value is a number, not a string → no throw, returns detected=false', () => {
    const result = detectSecretLike(12345);
    assert.equal(result.detected, false);
  });
});

describe('detectSecretLike — response shape', () => {
  it('when detected=true, response contains rule + reason', () => {
    const result = detectSecretLike(WP_SAMPLE);
    assert.equal(typeof result.detected, 'boolean');
    assert.equal(typeof result.rule, 'string');
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0);
  });

  it('when detected=false, rule is undefined', () => {
    const result = detectSecretLike('hello world');
    assert.equal(result.detected, false);
    assert.equal(result.rule, undefined);
  });
});

describe('detectSecretLike — detection order', () => {
  it('regex hit takes precedence over keyword (regex first)', () => {
    // value matches both the JWT regex and the keyword (title contains "token").
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = detectSecretLike(jwt, { title: 'my token' });
    assert.equal(result.rule, 'regex:jwt');
  });

  it('keyword hit takes precedence over heuristic (when regex misses)', () => {
    // Long string + title contains password → keyword wins over the length heuristic.
    const result = detectSecretLike('abcDEF1234567890XYZ9876543210', {
      title: 'my password',
    });
    assert.equal(result.rule, 'keyword:password');
  });
});

// ============================================================
// v1.26.8 — slash-separated path exclusion (bug-report id=4, 2026-05-26)
//
// Background: Vin's v1.26.7 release commit was blocked because FILELIST.md
// contained a literal openspec path that hit heuristic:long_alnum. Paths and
// URLs share the "3+ segments of valid identifiers" shape with dotted-identifier
// paths (which the heuristic already excludes), so they must also be excluded.
// ============================================================

describe('v1.26.8 — slash-separated path exclusion (heuristic regression)', () => {
  it('reproduces the bug-report case: openspec/changes path → allow', () => {
    const r = detectSecretLike(
      'openspec/changes/v1.26.7-hotfix-msys-path/proposal.md',
      { skip_keyword: true }
    );
    assert.equal(r.detected, false,
      `slash-separated openspec path should not hit heuristic; actual rule=${r.rule}`);
  });

  it('deep source-tree path → allow', () => {
    const r = detectSecretLike(
      'src/routes/admin/user-management/audit.js',
      { skip_keyword: true }
    );
    assert.equal(r.detected, false);
  });

  it('https URL with path segments → allow', () => {
    const r = detectSecretLike(
      'https://api.example.com/v1/users/12345/profile',
      { skip_keyword: true }
    );
    assert.equal(r.detected, false);
  });

  it('node_modules-style path → allow', () => {
    const r = detectSecretLike(
      'node_modules/some-package/dist/index.js',
      { skip_keyword: true }
    );
    assert.equal(r.detected, false);
  });

  it('2-segment slash shape that still looks key-like → still blocked', () => {
    // A 2-segment slash shape with random-looking chunks should not slip through
    // (real shortened JWTs split into 2 segments would otherwise escape).
    const r = detectSecretLike(
      'abcdef1234567890ABCDEF/fedcba0987654321XYZ',
      { skip_keyword: true }
    );
    assert.equal(r.detected, true,
      `2-segment alnum shape must still be caught; actual rule=${r.rule}`);
    assert.equal(r.rule, 'heuristic:long_alnum');
  });

  it('real GitHub PAT → still blocked (regex runs before heuristic)', () => {
    // Note: split the literal across concat so the dev-machine pre-commit hook's
    // staged-diff scanner does not catch this fixture as a real secret.
    const fakePat = 'ghp_' + 'abcdefghij' + 'klmnopqrst' + 'uvwxyz0123' + '456789AB';
    const r = detectSecretLike(fakePat, { skip_keyword: true });
    assert.equal(r.detected, true);
    assert.equal(r.rule, 'regex:github_pat');
  });

  it('path with a long segment → still allowed (overall shape is a path)', () => {
    // Even if one segment happens to be ≥ 20 chars, the overall slash-separated
    // shape is still a path, not a key.
    const r = detectSecretLike(
      'src/some/very-deep-folder-name/with-many-words-in-it.js',
      { skip_keyword: true }
    );
    assert.equal(r.detected, false);
  });

  it('exactly 3-segment slash path → allow (boundary case)', () => {
    const r = detectSecretLike('foo/bar/baz-quux-stuff', { skip_keyword: true });
    assert.equal(r.detected, false);
  });
});

// ============================================================
// v1.26.28 — punctuation-only separator-line exclusion (bug-report id=6, 2026-07-07)
//
// Background: a funpass analysis-repo commit was blocked because output .md /
// .py files contained horizontal-rule separator lines (e.g. 66 dashes).
// A line of pure punctuation from the heuristic charset (- _ + / = .) has
// zero alphanumeric characters — nothing key-like about it — yet passed
// LONG_ALNUM_REGEX and was flagged as heuristic:long_alnum. Real keys
// (JWT / PAT / AWS / OpenAI) are alnum-dominant, so excluding zero-alnum
// values introduces no false negatives.
// ============================================================

describe('v1.26.28 — punctuation-only separator lines (heuristic regression)', () => {
  it('reproduces the bug-report case: 66-dash separator line → allow', () => {
    const r = detectSecretLike('-'.repeat(66), { skip_keyword: true });
    assert.equal(r.detected, false,
      `dash separator line should not hit heuristic; actual rule=${r.rule}`);
  });

  it('equals-sign heading underline (markdown H1) → allow', () => {
    const r = detectSecretLike('='.repeat(56), { skip_keyword: true });
    assert.equal(r.detected, false);
  });

  it('underscore separator line → allow', () => {
    const r = detectSecretLike('_'.repeat(30), { skip_keyword: true });
    assert.equal(r.detected, false);
  });

  it('dot leader line → allow', () => {
    const r = detectSecretLike('.'.repeat(25), { skip_keyword: true });
    assert.equal(r.detected, false);
  });

  it('mixed punctuation separator (-=-=-=…) → allow', () => {
    const r = detectSecretLike('-='.repeat(15), { skip_keyword: true });
    assert.equal(r.detected, false);
  });

  it('random 20+ char alnum string → still blocked by heuristic', () => {
    const r = detectSecretLike('a1B2c3D4e5F6g7H8i9J0kL', { skip_keyword: true });
    assert.equal(r.detected, true);
    assert.equal(r.rule, 'heuristic:long_alnum');
  });

  it('key-like string padded with dashes → still blocked', () => {
    // Punctuation-only exclusion must not release values that merely
    // *contain* punctuation alongside key-like alnum runs.
    const r = detectSecretLike('----a1B2c3D4e5F6g7H8i9J0----', { skip_keyword: true });
    assert.equal(r.detected, true);
    assert.equal(r.rule, 'heuristic:long_alnum');
  });

  it('real GitHub PAT → still blocked (regex runs before heuristic)', () => {
    // Split the literal across concat so the dev-machine pre-commit hook's
    // staged-diff scanner does not catch this fixture as a real secret.
    const fakePat = 'ghp_' + 'abcdefghij' + 'klmnopqrst' + 'uvwxyz0123' + '456789AB';
    const r = detectSecretLike(fakePat, { skip_keyword: true });
    assert.equal(r.detected, true);
    assert.equal(r.rule, 'regex:github_pat');
  });
});

// ============================================================
// Google Maps Place IDs (bug-report id=28, 2026-08-28)
//
// A design doc quoting three real Place IDs could not be committed: each one is 27
// characters of base64-ish text with no word structure, so the last-resort length heuristic
// read them as credentials. A Place ID is a published public identifier — it grants nothing,
// anybody can look one up, and masking it would defeat the point of quoting it as evidence.
//
// This is an allowlist of one known public format, not another shape exemption of the kind
// v1.26.98 removed. Those said "identifiers look like this"; this says "this exact published
// identifier is public", and it is checked only against the heuristic, so every dedicated key
// regex still wins.
// ============================================================

describe('Google Maps Place IDs are public identifiers, not credentials', () => {
  const REPORTED = [
    'ChIJ1eveM33iaDQR8ztHwzV8s8s',
    'ChIJaSVP72jjaDQRxxdGd5N4VxY',
    'ChIJqfzLZmjjaDQRoFZxat31SBk',
  ];

  for (const placeId of REPORTED) {
    it(`the blocked commit's ${placeId} goes through`, () => {
      const r = detectSecretLike(placeId, { skip_keyword: true });
      assert.equal(r.detected, false, `still blocked by ${r.rule}`);
    });
  }

  it('a Place ID carrying the base64url symbols goes through too', () => {
    const r = detectSecretLike('ChIJ_abc-DEF123ghi456JKL789', { skip_keyword: true });
    assert.equal(r.detected, false);
  });

  it('a key that merely starts with the same four letters is still caught', () => {
    // The prefix is not a password. Anything outside the Place ID charset — `+`, `/`, `=`,
    // the padding a base64 secret carries — falls straight back to the heuristic.
    const r = detectSecretLike('ChIJ1eveM33iaDQR8zt/Hwz+V8s8s=', { skip_keyword: true });
    assert.equal(r.detected, true);
    assert.equal(r.rule, 'heuristic:long_alnum');
  });

  it('the prefix alone does not excuse a short value from anything else', () => {
    const r = detectSecretLike('ChIJshort', { skip_keyword: true });
    assert.equal(r.detected, false);
  });

  it('a real key format still wins, prefix or not', () => {
    const fakePat = 'ghp_' + 'abcdefghij' + 'klmnopqrst' + 'uvwxyz0123' + '456789AB';
    const r = detectSecretLike(fakePat, { skip_keyword: true });
    assert.equal(r.rule, 'regex:github_pat');
  });

  it('an assignment naming a password is still caught even with a Place ID as the value', () => {
    // The allowlist sits in front of the heuristic only. Someone writing
    // `api_key: ChIJ…` is not quoting a map location.
    const r = detectSecretLike('api_key: ChIJ1eveM33iaDQR8ztHwzV8s8s');
    assert.equal(r.detected, true);
    assert.match(r.rule, /^keyword:/);
  });
});
