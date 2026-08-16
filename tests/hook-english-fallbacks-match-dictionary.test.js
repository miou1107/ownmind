import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * v1.30.1 — every hard-coded English copy of a notice must equal `hooks/locales/en.json`.
 *
 * These literals are what a user reads when the dictionary cannot be loaded, or — for the
 * `.sh` twin and `action-gate-cli.js`'s outer `catch` — when node itself could not run the
 * gate, so there is no `t()` left to call. They are the least-exercised strings in the
 * product and the most important: `gate.failopen` is the line that says a command ran
 * without your rules ever checking it.
 *
 * Being least-exercised is exactly why they drift. Measured on this change set: all 24
 * notices were rewritten and three files were missed — `hooks/lib/action-gate-cli.js`,
 * `hooks/ownmind-iron-rule-check.js` and `hooks/ownmind-iron-rule-check.sh` kept the old
 * "the action gate could not run - this command was NOT gated". The `.sh` copy carried a
 * comment telling the next person to keep it in sync, and the spec file recorded that three
 * copies existed. Neither is a check, and both were read past. A user on a zh or ja machine
 * would have got the old actor-less English on the one line that matters most.
 *
 * So: a check, not a comment. Substring rather than exact-line matching, because these live
 * inside template literals, shell single quotes and JSON — the surrounding syntax differs per
 * file, the sentence must not.
 */

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const en = JSON.parse(fs.readFileSync(path.join(repoRoot, 'hooks', 'locales', 'en.json'), 'utf8'));

/**
 * file -> the dictionary keys it hard-codes. Deliberately a list somebody must extend when
 * they add a copy: an automatic scan would have to guess which strings are meant to be
 * notices, and would go quiet the moment a copy was reworded rather than failing.
 */
const HARD_CODED = {
  'hooks/lib/action-gate-cli.js': ['gate.failopen', 'gate.degraded'],
  'hooks/ownmind-iron-rule-check.js': ['gate.failopen', 'gate.degraded'],
  'hooks/ownmind-iron-rule-check.sh': ['gate.failopen'],
  'hooks/lib/action-gate.js': [
    'gate.ask.verbal', 'gate.read.blocked', 'gate.check.blocked',
    'gate.allow.verbal', 'gate.ask.forged',
  ],
  'hooks/lib/compliance-step.js': [
    'compliance.off.warnMode',
    'compliance.notChecked.noCredentials',
    'compliance.notChecked.neverSynced',
    'compliance.notChecked.signedOut',
    'compliance.notChecked.serverDeclined',
    'compliance.notChecked.checkFailed',
    'compliance.off.server',
  ],
};

/**
 * A value's fixed prose: the longest run that carries no placeholder, so a template literal
 * with `${guard.title}` spliced into it still matches on the words either side. The newline
 * the multi-line notices carry is dropped from the comparison for the same reason — the
 * source splits them across two concatenated literals.
 */
function fixedRuns(value) {
  return value
    .split(/\{\w+\}/)
    .flatMap((part) => part.split('\n'))
    .map((part) => part.trim())
    .filter((part) => part.length >= 25);
}

describe('hard-coded English notices match hooks/locales/en.json', () => {
  for (const [file, keys] of Object.entries(HARD_CODED)) {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    for (const key of keys) {
      it(`${file} carries the current "${key}" wording`, () => {
        const runs = fixedRuns(en[key]);
        assert.ok(runs.length > 0, `en.json "${key}" has no comparable fixed prose`);
        for (const run of runs) {
          assert.ok(
            source.includes(run),
            `${file} does not contain "${run}" — its hard-coded copy of "${key}" has drifted `
            + `from en.json. That copy is what ships when the dictionary cannot load, so the `
            + `drift is invisible until the day it matters. en.json says: ${JSON.stringify(en[key])}`,
          );
        }
      });
    }
  }

  it('no file still carries a pre-v1.30.1 notice', () => {
    // The specific sentences this change set replaced. Pinned by their old text rather than by
    // a general rule, because the failure was not "a wrong sentence" but "a sentence nobody
    // updated" — and the old one is the only thing that identifies those.
    const RETIRED = [
      'this command was NOT gated',
      'receipts unavailable, checks still enforced',
      'this turn was NOT checked',
      'compliance check did not run',
      'Reply quality lint',
      'OwnMind is currently disabled',
    ];
    const offenders = [];
    for (const file of Object.keys(HARD_CODED)) {
      const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      // Comments legitimately quote the old wording when they explain the change; only the
      // string literals matter. Crude but sufficient: strip // and # line comments.
      const code = source
        .split('\n')
        .filter((line) => !/^\s*(\/\/|#|\*)/.test(line))
        .join('\n');
      for (const retired of RETIRED) {
        if (code.includes(retired)) offenders.push(`${file}: ${retired}`);
      }
    }
    assert.deepEqual(offenders, [], `retired notice text still shipping:\n  ${offenders.join('\n  ')}`);
  });
});
