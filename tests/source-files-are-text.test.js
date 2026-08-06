import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Control bytes that make grep treat a source file as binary and skip it
// silently. Tab (09), LF (0a), CR (0d) are legitimate; the rest are not.
const FORBIDDEN = /[\x00-\x08\x0e-\x1f]/; // escapes, never a literal byte

// src/public/dashboard/ is a gitignored build output directory (see
// .gitignore: "src/public/dashboard/" - the compiled frontend bundle for the
// admin dashboard). It is machine-generated, not hand-written source, so
// grep-searchability of its minified bundle is not a concern this test cares
// about; skip it the same way node_modules and .git are skipped.
function jsFilesUnder(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dashboard') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) jsFilesUnder(full, found);
    else if (entry.endsWith('.js') || entry.endsWith('.cjs')) found.push(full);
  }
  return found;
}

describe('source files stay searchable', () => {
  it('no file under src/ contains a control byte', () => {
    const root = new URL('../src', import.meta.url).pathname;
    const offenders = jsFilesUnder(root)
      .filter((file) => FORBIDDEN.test(readFileSync(file, 'utf8')));
    assert.deepEqual(offenders, [], `control bytes make grep skip these files: ${offenders.join(', ')}`);
  });
});
