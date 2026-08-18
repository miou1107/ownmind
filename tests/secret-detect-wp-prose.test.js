import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { detectSecretLike } from '../shared/secret-detect.js';

// Built by joining, never written out whole: this repository ships the detector,
// so a contiguous key-shaped literal here blocks its own pre-commit scan.
const WP_SAMPLE = ['Qw3r', 'Ty7u', 'I0p2', 'As4d', 'Fg6h', 'Jk8l'].join(' ');

/**
 * v1.26.40 — bug report #8: the WP Application Password rule flagged ordinary
 * English prose.
 *
 * Committing scraped social data was blocked because a video description read
 * "...we hope that this vlog will help you on your Taiwan Journey." Six
 * consecutive four-letter words match the rule's shape exactly.
 *
 * Root cause: `wp_application_password` is the only rule in SECRET_REGEXES with
 * no identifying prefix (jwt has `eyJ`, github_pat has `gh?_`, aws has `AKIA`,
 * openai has `sk-`), so it matches on shape alone — and English produces that
 * shape often, because four-letter words are common. The v1.19.1 tightening
 * ({5,} → {5}, "to avoid matching ordinary English prose") constrained the
 * group count, not the character composition, so prose still matched.
 *
 * WordPress generates these with wp_generate_password(24, false): 24 characters
 * drawn at random from upper case, lower case, and digits only. A random draw
 * essentially never yields six groups that all look like plain words, whereas
 * prose groups always do. That difference is the discriminator.
 */

const WP_SAMPLE_2 = ['Zx9v', 'Bn4m', 'Qa2w', 'Se5d', 'Rf7t', 'Gy1h'].join(' ');

const REAL_PASSWORDS = [
  WP_SAMPLE,
  WP_SAMPLE_2,
];

/** Reproduce WordPress's own generator: 24 chars from [a-zA-Z0-9]. */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Seeded generator, so the sample is identical on every run.
 *
 * A live random draw would be flaky here: the composition rule's analytic miss
 * rate is 3·(26/62)^4 all six groups over = 6.378e-7, which makes a 2,000-draw
 * run fail about once in 784 against a perfectly correct implementation. A
 * security suite that cries wolf teaches people to re-run it.
 */
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateWpPassword(rand = () => crypto.randomInt(1e9) / 1e9) {
  let s = '';
  for (let i = 0; i < 24; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s.match(/.{4}/g).join(' ');
}

describe('WP Application Password rule — real passwords still caught', () => {
  for (const pw of REAL_PASSWORDS) {
    it(`detects ${pw.slice(0, 9)}…`, () => {
      const result = detectSecretLike(pw);
      assert.equal(result.detected, true);
      assert.equal(result.rule, 'regex:wp_application_password');
    });
  }

  it('detects passwords drawn the way WordPress draws them', () => {
    // Recall matters more than precision for a security control, so this runs a
    // sample rather than a single fixture. Seeded, so a green run means green
    // for everyone rather than "no miss happened to land this time".
    const rand = makeRng(20260729);
    const misses = [];
    for (let i = 0; i < 2000; i++) {
      const pw = generateWpPassword(rand);
      if (detectSecretLike(pw).rule !== 'regex:wp_application_password') misses.push(pw);
    }
    assert.deepEqual(misses, [], `missed ${misses.length} generated passwords`);
  });

  it('known limitation: a draw whose six groups all look like words is missed', () => {
    // Every group here is a legal draw from [a-zA-Z0-9] and every one is
    // word-shaped, so the composition rule cannot tell it from prose. Analytic
    // rate: (3·(26/62)^4)^6 = 6.378e-7, about 1 in 1.57 million. Accepted in
    // exchange for eliminating the false positives; pinned here so the residual
    // risk is visible in code rather than only in the proposal. If the rule
    // ever gains an entropy floor, this test should flip.
    const result = detectSecretLike('Abcd efgh Ijkl mnop QRST uvwx', { skip_keyword: true });
    assert.notEqual(result.rule, 'regex:wp_application_password');
  });

  it('still detects one embedded in surrounding text', () => {
    const result = detectSecretLike(`the key is ${WP_SAMPLE}, keep it safe`);
    assert.equal(result.rule, 'regex:wp_application_password');
  });
});

describe('WP Application Password rule — prose no longer flagged', () => {
  const PROSE = {
    'the reported sentence':
      'we successfully had a wonderful 5-day vacation in Taipei. We hope that this vlog will help you on your Taiwan Journey.',
    'title case': 'Hope That This Vlog Will Help You On Your Trip.',
    'all caps': 'HOPE THAT THIS VLOG WILL HELP',
    'plain lowercase run': 'this data came from open only when your team said okay',
    'wrapped across lines': 'when your team said okay\nCODE NAME ALFA BETA GAMA DELT',
  };

  for (const [label, text] of Object.entries(PROSE)) {
    it(`does not flag ${label}`, () => {
      const result = detectSecretLike(text, { skip_keyword: true });
      assert.notEqual(
        result.rule,
        'regex:wp_application_password',
        `flagged: ${JSON.stringify(result.matched_text)}`
      );
    });
  }
});

describe('WP Application Password rule — prose must not shadow a real password', () => {
  it('finds the password even when prose matches the shape first', () => {
    // The rule previously tested only the first shape match. If prose appears
    // earlier in the file than the real credential, checking just that one
    // would let the credential through — a far worse failure than the false
    // positive being fixed.
    const text = [
      'we hope that this vlog will help you on your trip',
      `wp_app_password: ${WP_SAMPLE}`,
    ].join('\n');
    const result = detectSecretLike(text, { skip_keyword: true });
    assert.equal(result.detected, true);
    assert.equal(result.rule, 'regex:wp_application_password');
    assert.match(result.matched_text, /Qw3r/);
  });

  it('reports the credential, not the prose, as the matched text', () => {
    const text = `this data came from open only when your team said okay. ${WP_SAMPLE_2}`;
    const result = detectSecretLike(text, { skip_keyword: true });
    assert.equal(result.rule, 'regex:wp_application_password');
    // Exact equality, not a substring probe: a shifted window that swallowed a
    // prose word and dropped a credential group would satisfy a looser check
    // while pointing the reader at the wrong fragment.
    assert.equal(result.matched_text, WP_SAMPLE_2);
  });

  // The scanner must consider overlapping windows. Advancing past the end of a
  // rejected match carves fixed six-token windows out of a contiguous run, so a
  // credential straddling a window boundary is never evaluated at all: with
  // five leading prose words the first window is 5 prose + credential group 1,
  // and the whole credential is skipped whenever that first group happens to be
  // word-shaped. That trades the false positive being fixed for a false
  // negative, which is the worse failure for a secret scanner.
  for (let lead = 1; lead <= 7; lead++) {
    it(`finds a credential sharing a token run with ${lead} preceding word(s)`, () => {
      const prose = ['that', 'this', 'vlog', 'will', 'help', 'from', 'open'].slice(0, lead);
      const credential = 'Abcd efgh Ijkl mnop qr9s tuvw';
      const result = detectSecretLike([...prose, credential].join(' '), { skip_keyword: true });
      assert.equal(result.rule, 'regex:wp_application_password', `missed with ${lead} leading word(s)`);
      // Not exact equality. When prose sits directly against a credential in
      // one token run, a window shifted a group or two earlier is itself a
      // legal match that passes `confirm`, and nothing in the text says where
      // the credential "really" begins. What the report must do is point at the
      // evidence, so require the group that proves this is not prose.
      assert.match(result.matched_text, /qr9s/);
    });
  }
});

describe('other regex rules are untouched', () => {
  it('JWT still detected', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    assert.equal(detectSecretLike(jwt).rule, 'regex:jwt');
  });

  it('GitHub PAT still detected', () => {
    assert.equal(
      detectSecretLike('ghp_abcdefghijklmnopqrstuvwxyz0123456789AB').rule,
      'regex:github_pat'
    );
  });

  it('AWS access key still detected', () => {
    assert.equal(detectSecretLike('AKIAIOSFODNN7EXAMPLE').rule, 'regex:aws_access_key');
  });
});
