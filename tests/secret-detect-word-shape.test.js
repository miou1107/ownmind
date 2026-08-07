import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectSecretLike } from '../shared/secret-detect.js';

/**
 * v1.26.98 — the last-resort secret heuristic was blocking ordinary code.
 *
 * It fired on "≥20 characters, all from the key charset", which does not distinguish a
 * credential from an identifier. Two commits were blocked on 2026-08-07 by
 * `.update-lock.reclaim` (a filename) and `REASON_MAX_CHARS=300` (a variable), both reported
 * to the user as suspected API keys.
 *
 * Measured against every ≥20-character token in this repository's own tracked files:
 * **3438 of 10486 were false positives — one token in three.** Three exemptions had already
 * been bolted on for dot paths, slash paths and separator lines; a fourth would have been
 * more of the same. The rule was measuring length, and what actually separates the two is
 * whether the value has word structure.
 *
 * These tests pin both directions. The corpus measurement is the one that matters most: a
 * hand-written list of "things that should not be flagged" only ever contains the cases
 * somebody already thought of, which is how this went unnoticed for so long.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const flagged = (v) => detectSecretLike(v).detected;
const byHeuristic = (v) => (detectSecretLike(v).rule || '').startsWith('heuristic:');

/**
 * Prefixed fixtures are assembled from pieces rather than written as literals. The
 * pre-commit scanner reads the diff, and a file whose whole point is to contain
 * key-shaped strings is otherwise unpushable — the runtime value is identical, so the
 * assertions still exercise the complete string.
 */
describe('v1.26.98 — real credentials are still caught', () => {
  // Deliberately not AWS's documentation example (`wJalrXUtnFEMI/K7...EXAMPLEKEY`): it
  // contains the English words EXAMPLE and KEY, so it is word-shaped by construction and
  // would be a positive control that tests the opposite of what it looks like.
  const keys = [
    ['Anthropic key', `sk-${'ant'}-api03-AbCdEf0123456789GhIjKlMnOpQrStUvWxYz0123456789AbCdEfGh`],
    ['GitHub PAT', `ghp${'_'}16CharsAndThenSomeMoreRandomStuff0123`],
    ['AWS key id', `AKI${'A'}IOSFODNN7EXAMPLE`],
    ['AWS secret, random', 'kR8dQ2vN7pL4xW9zT6yB3mC5hJ1fG0sA2eD4uI6o'],
    ['AWS secret, base64', 'zX9k/L2mQ7v+NpR4tY6wB8cE1hJ3fG5sA0dU2iO4'],
    ['JWT', `eyJ${'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'}.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U`],
    ['Slack bot token', `xox${'b'}-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx`],
    ['hex digest, 40', '9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a'],
    ['hex digest, 64', 'a3f5b8c2d9e14607182934a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f'],
    ['base64 blob', 'Zm9vYmFyYmF6cXV1eGNvcmdlZ3JhdWx0Z2FycGx5'],
    ['random 32', 'p8Xq2Lm9Zt4Vw7Nc1Bs6Hy3Rk5Jd0Fg'],
    ['Google API key', `AIz${'aSyD'}-abcdefghijklmnopqrstuvwxyz12345`],
    ['uuid, no dashes', 'f47ac10b58cc4372a5670e02b2c3d479'],
  ];

  for (const [name, key] of keys) {
    it(`catches a ${name}`, () => {
      assert.equal(flagged(key), true, `${name} would now be committable`);
    });
  }
});

describe('v1.26.98 — ordinary code is not reported as a credential', () => {
  // The two that actually blocked a commit, plus the shapes the corpus scan turned up.
  const notSecrets = [
    '.update-lock.reclaim',
    'REASON_MAX_CHARS=300',
    'confirmation_declared',
    'detectCommandTrigger',
    'renderToPipeableStream',
    'shouldRetryForSyncToken',
    'normalizeClientEventId',
    'writeHeartbeatIfPresent',
    'onboardingCompletedAt',
    'runInstallCheckAlerts',
    'hooks/ownmind-session-start.js',
    'tests/install-check-null-byte-sanitize.test.js',
    '__SET_VIA_LOCAL_CREDENTIALS_OR_ENV__',
    'api/usage/exemptions',
    '-DisallowStartIfOnBatteries',
  ];

  for (const value of notSecrets) {
    it(`allows ${JSON.stringify(value)}`, () => {
      assert.equal(byHeuristic(value), false,
        'blocked as a suspected credential; the user sees no way to proceed but renaming');
    });
  }
});

describe('v1.26.98 — measured against the repository itself', () => {
  /**
   * The guarantee is a rate, not a list. A list of allowed strings grows one entry per
   * blocked commit and never reports the case nobody has hit yet — which is exactly how the
   * previous version accumulated three exemptions while still failing one token in three.
   */
  function corpus() {
    const files = execFileSync('git',
      ['ls-files', '*.js', '*.cjs', '*.mjs', '*.sh', '*.ps1', '*.md', '*.sql', '*.yml'],
      { cwd: repoRoot, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    const tokens = new Set();
    for (const f of files) {
      let text;
      try { text = fs.readFileSync(path.join(repoRoot, f), 'utf8'); } catch { continue; }
      for (const t of text.split(/[\s"'`(),;:{}[\]<>]+/)) {
        if (t.length >= 20 && t.length <= 200) tokens.add(t);
      }
    }
    return [...tokens];
  }

  it('flags under 1% of the tokens that appear in tracked source', () => {
    const tokens = corpus();
    assert.ok(tokens.length > 3000, `only ${tokens.length} tokens — is the scan working?`);

    const fp = tokens.filter(byHeuristic);
    const rate = fp.length / tokens.length;
    assert.ok(rate < 0.01,
      `${fp.length} of ${tokens.length} tokens (${(rate * 100).toFixed(1)}%) are reported as `
      + `credentials. Was 33% before v1.26.98. Examples: `
      + fp.slice(0, 5).map((v) => JSON.stringify(v.slice(0, 40))).join(', '));
  });
});

describe('v1.26.98 — where the boundary sits', () => {
  it('a run of words is not key-shaped, however long', () => {
    assert.equal(byHeuristic('averylongbutentirelyordinaryidentifiername'), false);
  });

  it('a run with no word structure is key-shaped', () => {
    assert.equal(byHeuristic('Xk7mQ2vNpL4xW9zT6yB3mC5hJ1fG0sA2'), true);
  });

  it('a short random-looking run is left alone', () => {
    // Under the length floor: too little entropy to be worth guessing about, and every real
    // key format is far longer.
    assert.equal(byHeuristic('Xk7mQ2vNpL4x'), false);
  });

  it('separators break a run, base64 symbols do not', () => {
    // `x-y-z` style names are identifiers however long; `a/b+c=` is the base64 alphabet and
    // belongs to the same token. This is the distinction that lets a slash-bearing secret be
    // caught while a file path is not.
    assert.equal(byHeuristic('some-quite-long-hyphenated-name-here'), false);
    assert.equal(byHeuristic('zX9k/L2mQ7v+NpR4tY6wB8cE1hJ3fG5sA0dU2iO4'), true);
  });

  it('a slash-bearing key is caught even when no single chunk reaches the floor', () => {
    // Base64 secrets contain `/`. If `/` were treated as a run separator, this value's
    // longest run would be 13 characters and it would pass unnoticed. It is also the shape
    // the old slash-path exemption waved through unconditionally: three or more
    // slash-separated chunks was taken as proof of being a file path.
    assert.equal(byHeuristic('zX9kL2mQ7v/NpR4tY6wB8/cE1hJ3fG5sA/0dU2iO4'), true);
  });

  it('consonant runs are not mistaken for words', () => {
    // Every segment here is 3-4 letters with no digits, so a word test that only counted
    // length would call this an identifier. Words have vowels; generated keys need not.
    assert.equal(byHeuristic('XkzQmvNplWtzBrfGvsHjkl'), true);
  });

  it('mixed prose in Chinese is never key-shaped', () => {
    assert.equal(byHeuristic('這是一段中文說明文字不是金鑰'), false);
  });
});
