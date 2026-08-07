import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * The three READMEs are one document in three languages, so a release has to land in all
 * three. Nothing enforced that, and it was missed twice in a row: v1.26.90 and v1.26.91
 * both shipped with the English README bumped and the other two left on the previous
 * version, still describing a release that was no longer current.
 *
 * A convention nobody can fail loudly is not a convention. These two checks are the whole
 * guard: the stated version matches package.json, and a feature bullet dated to the current
 * version appears in every language or in none.
 */

const ROOT = new URL('../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), 'utf8');

const VERSION = JSON.parse(read('package.json')).version;

/** Each README states the current version on its own line, in its own wording. */
const READMES = [
  { path: 'README.md', versionLine: /\*\*Current version: v([\d.]+)\*\*/ },
  { path: 'docs/README.zh-TW.md', versionLine: /\*\*目前版本：v([\d.]+)\*\*/ },
  { path: 'docs/README.ja.md', versionLine: /\*\*現在のバージョン：v([\d.]+)\*\*/ },
];

describe('the three READMEs stay in sync', () => {
  it('every README states the version in package.json', () => {
    const stated = READMES.map(({ path, versionLine }) => {
      const m = read(path).match(versionLine);
      assert.ok(m, `${path}: no version line matched ${versionLine} — did the wording change?`);
      return { path, version: m[1] };
    });

    const behind = stated.filter(s => s.version !== VERSION);
    assert.deepEqual(
      behind, [],
      `package.json is ${VERSION}; these are behind: ${behind.map(b => `${b.path}=${b.version}`).join(', ')}`
    );
  });

  it('a feature bullet dated to this version appears in all three or in none', () => {
    // Bullets are stamped with a trailing `v1.2.3`, so this is checkable without reading
    // the prose. Partial coverage is the failure being pinned: it means the release was
    // written up in one language and the other two silently describe an older product.
    const marker = '`v' + VERSION + '`';
    const withBullet = READMES.filter(({ path }) => read(path).includes(marker));

    assert.ok(
      withBullet.length === 0 || withBullet.length === READMES.length,
      `${marker} is documented in ${withBullet.map(w => w.path).join(', ')} but missing from ` +
      READMES.filter(r => !withBullet.includes(r)).map(r => r.path).join(', ')
    );
  });
});
