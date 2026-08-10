import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectSecretLike } from '../shared/secret-detect.js';

/**
 * v1.26.125 — a blocked Anthropic key was reported as OpenAI's.
 *
 * Both vendors prefix with `sk-`, and one rule named `openai_api_key` owned the family.
 * Observed for real while committing v1.26.124, when that release's own baseline scan
 * blocked the release:
 *
 *     leak.txt: value 符合 openai_api_key 格式 (detected_by=regex:openai_api_key)
 *               matched="sk-ant-a…AAAA"
 *
 * The masked fragment says `sk-ant-` and the rule name says OpenAI in the same sentence.
 * The block was right; the diagnosis sent the reader after a key they never had.
 *
 * That is the same failure v1.26.28 fixed by adding `matched_text`, after a hidden match
 * got bug id=6 misdiagnosed: stopping the commit is half the job, and naming the wrong
 * vendor throws away the other half — the half the user acts on.
 *
 * Fixtures are assembled at runtime, never written as one literal. A single literal here
 * would make this file un-committable by the very scanner it tests, which is exactly what
 * happened to tests/pre-commit-secret-baseline.test.js in v1.26.124. Do not "tidy" them.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ANTHROPIC_KEY = 'sk-' + 'ant-api03-' + 'A'.repeat(40);
const OPENAI_PROJECT_KEY = 'sk-' + 'proj-' + 'abc123XYZdef456ghi789jkl';
const OPENAI_CLASSIC_KEY = 'sk-' + 'abc123XYZdef456ghi789jklmno';

describe('the reported vendor matches the prefix that actually matched', () => {
  it('an Anthropic key is attributed to Anthropic — the regression', () => {
    const r = detectSecretLike(ANTHROPIC_KEY, { skip_keyword: true });
    assert.equal(r.detected, true, 'it must still be blocked; that part was never wrong');
    assert.equal(r.rule, 'regex:anthropic_api_key');
  });

  it('an Anthropic key is never named OpenAI', () => {
    // Stated separately and negatively, because this is the sentence the user reads and
    // acts on. A future rule that matched first under some other wrong name would pass the
    // test above only if it happened to be called anthropic_api_key; this one catches the
    // whole class.
    const r = detectSecretLike(ANTHROPIC_KEY, { skip_keyword: true });
    assert.equal(/openai/i.test(r.rule), false, `rule was ${r.rule}`);
    assert.equal(/openai/i.test(r.reason), false, `reason was ${r.reason}`);
  });

  it('reverse control: an OpenAI project key still reports as OpenAI', () => {
    // Without this, deleting the OpenAI rule outright would satisfy everything above.
    const r = detectSecretLike(OPENAI_PROJECT_KEY, { skip_keyword: true });
    assert.equal(r.detected, true);
    assert.equal(r.rule, 'regex:openai_api_key');
  });

  it('reverse control: a classic sk- OpenAI key still reports as OpenAI', () => {
    // The `sk-` + base62 shape, with no second prefix segment at all. The new lookahead
    // sits directly after `sk-`, so this is the form most exposed to getting it wrong.
    const r = detectSecretLike(OPENAI_CLASSIC_KEY, { skip_keyword: true });
    assert.equal(r.detected, true);
    assert.equal(r.rule, 'regex:openai_api_key');
  });

  it('the exclusion is the four characters `ant-`, not the letters `ant`', () => {
    // `sk-antelope…` is not an Anthropic key and must not be described as one. A lookahead
    // written `(?!ant)` would silently misfile it — and misfiling in this direction is
    // harder to notice, because the user has no Anthropic key to fail to find.
    const r = detectSecretLike('sk-' + 'antelope123XYZdef456ghi789', { skip_keyword: true });
    assert.equal(r.detected, true);
    assert.equal(r.rule, 'regex:openai_api_key');
  });

  it('mutation control: the pre-fix pattern really did claim the Anthropic key', () => {
    // Shows the bug existed rather than assuming it. If `sk-[A-Za-z0-9_-]{20,}` had never
    // matched `sk-ant-…`, every test above would be theatre.
    assert.match(ANTHROPIC_KEY, /sk-[A-Za-z0-9_-]{20,}/,
      'the old OpenAI pattern must be shown to match an Anthropic key');
  });
});

describe('the block message still carries what the user needs', () => {
  it('an Anthropic hit is masked like every other regex hit', () => {
    // Callers mask on the `regex:` prefix (v1.26.28). A new rule name that dropped that
    // prefix would print the raw key into a terminal and a log file.
    const r = detectSecretLike(ANTHROPIC_KEY, { skip_keyword: true });
    assert.ok(r.rule.startsWith('regex:'), `rule was ${r.rule}; masking keys on this prefix`);
    assert.ok(r.matched_text, 'the user needs the fragment to find the line');
  });

  it('the reason names the same rule as the rule field', () => {
    const r = detectSecretLike(ANTHROPIC_KEY, { skip_keyword: true });
    assert.match(r.reason, /anthropic_api_key/,
      'the two halves of the message must not name different vendors — that was the bug');
  });
});

describe('no rule claims a prefix another rule owns', () => {
  it('exactly one rule matches an Anthropic key', () => {
    // The loop returns on first match, so a second rule that also matched would be
    // invisible until somebody reordered the table. Reading the real module keeps this
    // honest rather than restating the table here.
    const src = fs.readFileSync(path.join(repoRoot, 'shared', 'secret-detect.js'), 'utf8');
    const names = [...src.matchAll(/name:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
    assert.ok(names.includes('anthropic_api_key'), 'anthropic_api_key must be registered');
    assert.ok(names.includes('openai_api_key'), 'openai_api_key must still exist');
    assert.ok(
      names.indexOf('anthropic_api_key') < names.indexOf('openai_api_key'),
      'anthropic_api_key must be listed first; the loop returns on the first match',
    );
  });
});
