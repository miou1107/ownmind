import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.js';
import {
  readEnforcementBundle,
  writeEnforcementBundle,
  mayReplaceBundle,
} from '../hooks/lib/enforcement-cache.js';

const BUNDLE = {
  selectors: [{ id: 412, type: 'team_standard', tags: [], keywords: ['FAPA'], always_check: false, repo_match: 'r' }],
  guards: [{ id: 412, title: 'ci ownership', repo_match: 'r', paths: ['ci/**'], owner: 'Eric' }],
  injectables: [{ id: 412, title: 'ci ownership', content: 'Only Eric may edit ci/.', keywords: ['FAPA'], always_check: false, repo_match: 'r', paths: ['ci/**'], owner: 'Eric' }],
};

function cacheIn(dir) {
  return path.join(dir, 'enforcement.json');
}

test('a bundle written here reads back with all three lists', () => {
  const file = cacheIn(tempDir('om-enf-cache-'));
  assert.equal(writeEnforcementBundle(BUNDLE, file), true);
  const read = readEnforcementBundle(file);
  assert.deepEqual(read.guards, BUNDLE.guards);
  assert.deepEqual(read.selectors, BUNDLE.selectors);
  assert.equal(read.injectables[0].content, 'Only Eric may edit ci/.');
});

test('a cache that was never written reports present: false, not an empty rule set', () => {
  // These are different facts and the difference decides behaviour. "No rules matched" is a
  // quiet, correct turn; "this machine has never synced" means every check is silently
  // disabled. Collapsing them is how a fresh install comes to look healthy while enforcing
  // nothing at all.
  const read = readEnforcementBundle(cacheIn(tempDir('om-enf-cache-')));
  assert.equal(read.present, false);
  assert.deepEqual(read.selectors, []);
});

test('a bundle that was written reports present: true even when every list is empty', () => {
  const file = cacheIn(tempDir('om-enf-cache-'));
  writeEnforcementBundle({ selectors: [], guards: [], injectables: [] }, file);
  const read = readEnforcementBundle(file);
  assert.equal(read.present, true, 'an account with no annotated rules has still synced');
});

test('a corrupt cache file reads as absent rather than throwing', () => {
  const file = cacheIn(tempDir('om-enf-cache-'));
  fs.writeFileSync(file, '{ this is not json');
  const read = readEnforcementBundle(file);
  assert.equal(read.present, false);
  assert.deepEqual(read.guards, []);
});

test('an empty bundle may not overwrite a populated one', () => {
  // One empty response once disarmed every iron rule at once. Emptiness is far more often a
  // broken request than a user who deleted everything, and a stale cache still enforces
  // something while an empty one enforces nothing.
  assert.equal(mayReplaceBundle({ selectors: [], guards: [], injectables: [] }, BUNDLE), false);
});

test('a populated bundle may replace anything', () => {
  assert.equal(mayReplaceBundle(BUNDLE, { selectors: [], guards: [], injectables: [] }), true);
  assert.equal(mayReplaceBundle(BUNDLE, null), true);
});

test('an empty bundle may replace an already-empty one', () => {
  const empty = { selectors: [], guards: [], injectables: [] };
  assert.equal(mayReplaceBundle(empty, empty), true);
});

test('writing an empty bundle over a populated file leaves the file untouched', () => {
  const file = cacheIn(tempDir('om-enf-cache-'));
  writeEnforcementBundle(BUNDLE, file);
  assert.equal(writeEnforcementBundle({ selectors: [], guards: [], injectables: [] }, file), false);
  assert.deepEqual(readEnforcementBundle(file).guards, BUNDLE.guards);
});

test('a malformed payload is refused rather than written', () => {
  const file = cacheIn(tempDir('om-enf-cache-'));
  assert.equal(writeEnforcementBundle(null, file), false);
  assert.equal(writeEnforcementBundle({ selectors: 'nope' }, file), false);
  assert.equal(readEnforcementBundle(file).present, false);
});
