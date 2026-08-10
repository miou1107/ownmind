import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCacheableRule, filterCacheableRules } from '../shared/cacheable-rules.js';
import { extractEnabledValidators } from '../shared/validators/index.js';

/**
 * v1.26.124 — configuring a reply-lint validator could not take effect, because the rule
 * carrying it never reached the file the reply-lint hook reads.
 *
 * `~/.ownmind/cache/iron_rules.json` was built as "the verifiable rules": everything with
 * `metadata.verification`, for the commit-time engine. v1.21.0 then pointed the reply-lint
 * Stop hook at the same file, looking for `metadata.lint_validator` — and nobody widened
 * the filter. A rule with a validator and no verification block was fetched from the
 * server and dropped on the way to disk.
 *
 * Measured: an account whose three iron rules were all reminder-only had a two-byte cache
 * (`[]`), so the Stop hook resolved zero validators and returned "no violations" for a
 * reply the lint engine scores at 79.3% mixed language. It exited 0 in silence, which is
 * exactly what a clean reply looks like.
 *
 * Both writers of this file are covered below. They must agree: the pre-commit hook
 * rewrites the cache whenever it finds it empty, so a narrower filter there would delete
 * the reply-lint rules on the next commit even after the MCP wrote them correctly.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const VERIFICATION_ONLY = {
  code: 'IR-100',
  metadata: { verification: { trigger: ['commit'], conditions: { type: 'staged_files_exclude' } } },
};
const VALIDATOR_ONLY = {
  code: 'IR-004',
  metadata: { lint_validator: { name: 'language_mixed_ratio', params: { threshold: 0.15 } } },
};
const BOTH = {
  code: 'IR-101',
  metadata: {
    verification: { trigger: ['commit'] },
    lint_validator: { name: 'jargon_explanation', params: {} },
  },
};
const REMINDER_ONLY = { code: 'IR-102', metadata: { origin_context: { project: 'OwnMind' } } };

describe('isCacheableRule', () => {
  it('keeps a rule the commit engine needs', () => {
    assert.equal(isCacheableRule(VERIFICATION_ONLY), true);
  });

  it('keeps a rule only the reply-lint hook needs — the regression', () => {
    // This is the whole defect: before the fix this rule was dropped, and enabling a reply
    // check was therefore a no-op that reported nothing.
    assert.equal(isCacheableRule(VALIDATOR_ONLY), true);
  });

  it('keeps a rule both consumers need', () => {
    assert.equal(isCacheableRule(BOTH), true);
  });

  it('drops a reminder-only rule — the cache must not become "every rule"', () => {
    // Reverse control. Widening the filter to everything would satisfy the tests above
    // while putting the whole rule set, content and all, on disk for both hooks to parse
    // on every commit and every reply.
    assert.equal(isCacheableRule(REMINDER_ONLY), false);
  });

  it('drops malformed entries instead of throwing', () => {
    for (const bad of [null, undefined, 42, 'rule', {}, { metadata: null }, { metadata: 'x' }]) {
      assert.equal(isCacheableRule(bad), false, `should have dropped ${JSON.stringify(bad)}`);
    }
  });
});

describe('filterCacheableRules', () => {
  it('keeps exactly the two kinds, in order', () => {
    const kept = filterCacheableRules([REMINDER_ONLY, VALIDATOR_ONLY, VERIFICATION_ONLY, BOTH]);
    assert.deepEqual(kept.map((r) => r.code), ['IR-004', 'IR-100', 'IR-101']);
  });

  it('a non-array is empty, not a crash', () => {
    for (const bad of [null, undefined, {}, 'rules']) assert.deepEqual(filterCacheableRules(bad), []);
  });

  it('what survives is what the reply-lint hook can actually enable', () => {
    // The end of the chain the bug broke: cache -> extractEnabledValidators -> the check
    // that runs. Asserting against the real extractor rather than restating its rule means
    // a change to either side fails here.
    const enabled = extractEnabledValidators(filterCacheableRules([REMINDER_ONLY, VALIDATOR_ONLY]));
    assert.equal(enabled.length, 1);
    assert.equal(enabled[0].validator, 'language_mixed_ratio');
    assert.equal(enabled[0].rule, 'IR-004');
  });

  it('mutation control: the old verification-only filter loses the validator', () => {
    // Without this the fix is unfalsifiable — it shows the pre-fix expression really did
    // drop the rule, rather than the two filters happening to agree on this fixture.
    const oldWay = [REMINDER_ONLY, VALIDATOR_ONLY].filter((r) => r.metadata?.verification);
    assert.deepEqual(extractEnabledValidators(oldWay), [],
      'the pre-fix filter must be shown to disable the check, or this test proves nothing');
  });
});

describe('both writers of the cache use the same predicate', () => {
  // Two programs write ~/.ownmind/cache/iron_rules.json. While they disagreed about what
  // belongs in it, whichever wrote last decided what the other could see.
  const WRITERS = [
    'mcp/index.js',
    'hooks/ownmind-git-pre-commit.js',
  ];

  for (const rel of WRITERS) {
    it(`${rel} filters through shared/cacheable-rules.js`, () => {
      const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      const code = src
        .split(/\r?\n/)
        .map((line) => line.replace(/\/\/.*$/, ''))
        .join('\n')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      assert.match(code, /filterCacheableRules\s*\(/,
        `${rel} must use the shared predicate when writing the rule cache`);
      assert.equal(
        /\.filter\(\s*\(?r\)?\s*=>\s*r\.metadata\?\.verification\s*\)/.test(code),
        false,
        `${rel} still narrows the cache to verification-only rules, which deletes the reply-lint hook's rules`,
      );
    });
  }

  it('reverse control: the guard fires on the expression it exists to catch', () => {
    const pre = 'const verifiable = allRules.filter(r => r.metadata?.verification);';
    assert.ok(/\.filter\(\s*\(?r\)?\s*=>\s*r\.metadata\?\.verification\s*\)/.test(pre));
  });
});
