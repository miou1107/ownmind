import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const helperPath = path.join(__dirname, '..', 'scripts', 'install-helpers', 'path-to-win32.cjs');

/**
 * v1.26.7 hotfix — path-to-win32 helper round-trip tests
 *
 * Reproduces Vin's 2026-05-26 bug report: under Git Bash on Windows, $OWNMIND_DIR
 * expands to /c/Users/Vin/.ownmind (MSYS style), which Node.exe's require() does
 * not recognize. The helper has existed since v1.17.66 (commit a2f701c) but was
 * never exercised by tests, so the bug shipped unnoticed.
 *
 * These tests mock process.platform to 'win32' so they can run on the Mac CI too.
 */

const { toWin32Path, toMsysPath, isMsysPath, isWin32Path } = require(helperPath);

describe('v1.26.7 — path-to-win32: detection predicates', () => {
  it('isMsysPath recognizes /c/... and /D/... style', () => {
    assert.equal(isMsysPath('/c/Users/Vin/.ownmind'), true);
    assert.equal(isMsysPath('/D/data'), true);
    assert.equal(isMsysPath('/c'), true);
    assert.equal(isMsysPath('/c/'), true);
  });

  it('isMsysPath rejects plain POSIX paths and Windows paths', () => {
    assert.equal(isMsysPath('/Users/Vin/.ownmind'), false);
    assert.equal(isMsysPath('C:\\Users\\Vin'), false);
    assert.equal(isMsysPath('C:/Users/Vin'), false);
    assert.equal(isMsysPath(''), false);
    assert.equal(isMsysPath(null), false);
    assert.equal(isMsysPath(undefined), false);
  });

  it('isWin32Path recognizes drive paths and UNC roots', () => {
    assert.equal(isWin32Path('C:\\Users\\Vin'), true);
    assert.equal(isWin32Path('C:/Users/Vin'), true);
    assert.equal(isWin32Path('d:/data'), true);
    assert.equal(isWin32Path('\\\\server\\share'), true);
  });

  it('isWin32Path rejects MSYS and plain POSIX paths', () => {
    assert.equal(isWin32Path('/c/Users/Vin'), false);
    assert.equal(isWin32Path('/Users/Vin'), false);
    assert.equal(isWin32Path(''), false);
    assert.equal(isWin32Path(null), false);
  });
});

describe('v1.26.7 — path-to-win32: toWin32Path under win32 (mocked)', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  before(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  });

  after(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('reproduces the 2026-05-26 bug case: /c/Users/Vin/.ownmind → C:\\Users\\Vin\\.ownmind', () => {
    assert.equal(toWin32Path('/c/Users/Vin/.ownmind'), 'C:\\Users\\Vin\\.ownmind');
  });

  it('uppercases the drive letter', () => {
    assert.equal(toWin32Path('/c/foo'), 'C:\\foo');
    assert.equal(toWin32Path('/d/bar'), 'D:\\bar');
  });

  it('handles drive-only MSYS path (/c → C:\\)', () => {
    assert.equal(toWin32Path('/c'), 'C:\\');
    assert.equal(toWin32Path('/c/'), 'C:\\');
  });

  it('passes Win32 paths through unchanged', () => {
    assert.equal(toWin32Path('C:\\Users\\Vin'), 'C:\\Users\\Vin');
    assert.equal(toWin32Path('C:/Users/Vin'), 'C:/Users/Vin');
    assert.equal(toWin32Path('\\\\server\\share'), '\\\\server\\share');
  });

  it('passes plain POSIX paths through (caller decides whether to convert)', () => {
    // A literal /Users/Vin is not a Windows path and not MSYS — leave it alone.
    assert.equal(toWin32Path('/Users/Vin'), '/Users/Vin');
  });

  it('handles non-string input gracefully', () => {
    assert.equal(toWin32Path(null), null);
    assert.equal(toWin32Path(undefined), undefined);
    assert.equal(toWin32Path(42), 42);
  });
});

describe('v1.26.7 — path-to-win32: toMsysPath under win32 (mocked)', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  before(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  });

  after(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('C:\\Users\\Vin → /c/Users/Vin (round-trip with toWin32Path)', () => {
    assert.equal(toMsysPath('C:\\Users\\Vin'), '/c/Users/Vin');
  });

  it('C:/Users/Vin (forward-slash Win32) → /c/Users/Vin', () => {
    assert.equal(toMsysPath('C:/Users/Vin'), '/c/Users/Vin');
  });

  it('lowercases the drive letter on the way back', () => {
    assert.equal(toMsysPath('D:\\data'), '/d/data');
  });

  it('passes MSYS paths through unchanged', () => {
    assert.equal(toMsysPath('/c/Users/Vin'), '/c/Users/Vin');
  });

  it('round-trip /c/foo/bar → C:\\foo\\bar → /c/foo/bar', () => {
    const msys = '/c/foo/bar';
    const win32 = toWin32Path(msys);
    assert.equal(win32, 'C:\\foo\\bar');
    assert.equal(toMsysPath(win32), msys);
  });
});

describe('v1.26.7 — path-to-win32: no-op on non-win32 platforms', () => {
  // The Mac/Linux test pass is the actual default — toWin32Path / toMsysPath
  // should be transparent so the helper does not damage POSIX builds.
  if (process.platform === 'win32') {
    it('skipped — running on real win32', () => {});
    return;
  }

  it('toWin32Path returns input unchanged on Mac/Linux', () => {
    assert.equal(toWin32Path('/c/Users/Vin'), '/c/Users/Vin');
    assert.equal(toWin32Path('C:\\foo'), 'C:\\foo');
  });

  it('toMsysPath returns input unchanged on Mac/Linux', () => {
    assert.equal(toMsysPath('C:\\Users\\Vin'), 'C:\\Users\\Vin');
    assert.equal(toMsysPath('/c/Users/Vin'), '/c/Users/Vin');
  });
});
