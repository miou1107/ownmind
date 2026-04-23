import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { parseSemver, compareSemver, isLower, isHigher, isLowerOrEqual } =
  await import('../src/utils/semver.js');

describe('parseSemver', () => {
  it('parses standard X.Y.Z', () => {
    assert.deepEqual(parseSemver('1.17.0'), [1, 17, 0, 1]);
    assert.deepEqual(parseSemver('10.0.3'), [10, 0, 3, 1]);
  });

  it('treats pre-release as preFlag=0 (lower than stable)', () => {
    assert.deepEqual(parseSemver('1.17.0-dev'), [1, 17, 0, 0]);
    assert.deepEqual(parseSemver('1.17.0-beta'), [1, 17, 0, 0]);
    assert.deepEqual(parseSemver('1.17.0-rc.1'), [1, 17, 0, 0]);
  });

  it('strips build metadata (+xxx)', () => {
    assert.deepEqual(parseSemver('1.17.0+sha.abc'), [1, 17, 0, 1]);
    assert.deepEqual(parseSemver('1.17.0-beta+sha.abc'), [1, 17, 0, 0]);
  });

  it('falls back to [0,0,0,0] for invalid input', () => {
    assert.deepEqual(parseSemver(null), [0, 0, 0, 0]);
    assert.deepEqual(parseSemver(undefined), [0, 0, 0, 0]);
    assert.deepEqual(parseSemver(''), [0, 0, 0, 0]);
    assert.deepEqual(parseSemver('unknown'), [0, 0, 0, 0]);
    assert.deepEqual(parseSemver('garbage'), [0, 0, 0, 0]);
    assert.deepEqual(parseSemver('1.17'), [0, 0, 0, 0]);       // 少一段
    assert.deepEqual(parseSemver('1.17.x'), [0, 0, 0, 0]);    // patch 非數字
  });
});

describe('compareSemver numeric cases', () => {
  it('sorts numerics correctly (1.10.0 > 1.9.0)', () => {
    assert.ok(compareSemver('1.10.0', '1.9.0') > 0, '1.10.0 應該大於 1.9.0');
    assert.ok(compareSemver('2.0.0', '1.99.99') > 0);
    assert.ok(compareSemver('1.17.1', '1.17.0') > 0);
  });

  it('returns 0 for identical versions', () => {
    assert.equal(compareSemver('1.17.0', '1.17.0'), 0);
  });
});

describe('compareSemver pre-release semantics', () => {
  it('pre-release is lower than stable of same numeric', () => {
    assert.ok(compareSemver('1.17.0-beta', '1.17.0') < 0,
      '1.17.0-beta 應該小於 1.17.0');
    assert.ok(compareSemver('1.17.0-dev', '1.17.0') < 0);
  });

  it('pre-release of higher numeric still wins', () => {
    assert.ok(compareSemver('1.18.0-beta', '1.17.0') > 0,
      '1.18.0-beta 即便是 pre-release 也大於 1.17.0');
  });
});

describe('isLower / isHigher convenience wrappers', () => {
  it('isLower handles pre-release correctly (beta vs stable)', () => {
    assert.ok(isLower('1.17.0-beta', '1.17.0'));
    assert.ok(!isLower('1.17.0', '1.17.0-beta'));
  });

  it('isLower handles invalid input by treating it as [0,0,0,0]', () => {
    assert.ok(isLower(null, '1.17.0'));
    assert.ok(isLower('unknown', '1.17.0'));
    assert.ok(!isLower('1.17.0', null));
  });

  it('isHigher for newer numeric', () => {
    assert.ok(isHigher('1.18.0', '1.17.0'));
    assert.ok(!isHigher('1.17.0', '1.18.0'));
  });

  it('isLowerOrEqual for equal', () => {
    assert.ok(isLowerOrEqual('1.17.0', '1.17.0'));
  });
});
