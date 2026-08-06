import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * The API wraps its responses as { data: [...] }. Three hooks read that endpoint:
 *
 *   hooks/ownmind-iron-rule-check.js   — fixed in v1.19.20
 *   hooks/ownmind-iron-rule-check.sh   — missed; threw on every run, output swallowed
 *   hooks/ownmind-git-pre-commit.js    — missed; yielded nothing, silently
 *
 * The .sh variant is the one wired into a real installation's settings.json, so
 * its failure meant no iron-rule reminders at all. These tests pin the shape
 * handling for the two variants that parse the response inline.
 */

const WRAPPED = JSON.stringify({
  data: [{ code: 'IR-008', tags: ['trigger:commit'], title: 'x', content: 'y' }],
});
const BARE = JSON.stringify([{ code: 'IR-008', tags: ['trigger:commit'], title: 'x', content: 'y' }]);

/** Pull the parse lines out of a hook file and run them for real against a body. */
function runParse(source, body) {
  const script = `
    const d = ${JSON.stringify(body)};
    ${source}
    console.log(JSON.stringify(rules.length));
  `;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim());
}

describe('ownmind-iron-rule-check.sh unwraps the response envelope', () => {
  const sh = readFileSync(new URL('../hooks/ownmind-iron-rule-check.sh', import.meta.url), 'utf8');

  it('contains the unwrap rather than calling .filter on the envelope', () => {
    assert.match(sh, /Array\.isArray\(parsed\)\s*\?\s*parsed\s*:\s*\(parsed\.data/);
  });

  it('the extracted parse actually reads the wrapped shape', () => {
    const parseSource = `
      const parsed = JSON.parse(d);
      const rules = Array.isArray(parsed) ? parsed : (parsed.data || []);
    `;
    // Guard that the snippet under test is the one the script really carries.
    assert.ok(
      sh.includes('const rules = Array.isArray(parsed) ? parsed : (parsed.data || []);'),
      'the script no longer carries the parse this test exercises'
    );
    assert.equal(runParse(parseSource, WRAPPED), 1);
    assert.equal(runParse(parseSource, BARE), 1);
  });

  it('the old parse would have thrown on the wrapped shape', () => {
    // The defect, reproduced: this is what the script did before v1.26.87.
    assert.throws(() => {
      const parsed = JSON.parse(WRAPPED);
      parsed.filter(() => true);
    }, TypeError);
  });
});

describe('ownmind-iron-rule-check.js keeps its v1.19.20 fix', () => {
  const js = readFileSync(new URL('../hooks/ownmind-iron-rule-check.js', import.meta.url), 'utf8');

  it('still handles both shapes', () => {
    assert.match(js, /Array\.isArray\(parsed\)\s*\?\s*parsed\s*:\s*\(parsed\.data/);
  });
});
