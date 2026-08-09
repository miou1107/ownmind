import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Control bytes that make grep treat a source file as binary and skip it
// silently. Tab (09), LF (0a), CR (0d) are legitimate; the rest are not.
const FORBIDDEN = /[\x00-\x08\x0e-\x1f]/; // escapes, never a literal byte

// src/public/dashboard/ is a gitignored build output directory (see
// .gitignore: "src/public/dashboard/" - the compiled frontend bundle for the
// admin dashboard). It is machine-generated, not hand-written source, so
// grep-searchability of its minified bundle is not a concern this test cares
// about; skip it the same way node_modules and .git are skipped. Matched by
// full relative path, not by directory name, so a future hand-written
// directory that happens to also be called "dashboard" still gets scanned.
const SKIPPED_DIR = join('public', 'dashboard'); // relative to src/

function jsFilesUnder(dir, root = dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(dir, entry);
    const relativeToRoot = full.slice(root.length + 1);
    if (relativeToRoot === SKIPPED_DIR) continue;
    if (statSync(full).isDirectory()) jsFilesUnder(full, root, found);
    else if (entry.endsWith('.js') || entry.endsWith('.cjs')) found.push(full);
  }
  return found;
}

// Invisible characters that are not control bytes, so grep still reads the file,
// but that any "normalise whitespace" editor pass will silently delete or convert.
// A regex character class carrying one of these changes meaning when that happens,
// and nothing about the diff looks alarming. Written as escapes, never literals.
const INVISIBLE = /[\uFEFF\u200B-\u200D\u2060\u00A0]/; // escapes, never literals

// Directories whose sources must stay both searchable and editor-safe. The
// installer helpers earn their place here: two of them have already shipped with
// a literal NUL inside a comment (v1.26.87) and a literal U+FEFF inside a regex.
const SCANNED = ['../src', '../scripts/install-helpers', '../hooks'];

describe('source files stay searchable', () => {
  for (const rel of SCANNED) {
    it(`no file under ${rel.replace('../', '')}/ contains a control byte`, () => {
      const root = fileURLToPath(new URL(rel, import.meta.url));
      const offenders = jsFilesUnder(root)
        .filter((file) => FORBIDDEN.test(readFileSync(file, 'utf8')));
      assert.deepEqual(offenders, [], `control bytes make grep skip these files: ${offenders.join(', ')}`);
    });
  }
});

describe('source files survive an editor that normalises invisible characters', () => {
  for (const rel of SCANNED) {
    it(`no file under ${rel.replace('../', '')}/ carries a literal invisible character`, () => {
      const root = fileURLToPath(new URL(rel, import.meta.url));
      const offenders = jsFilesUnder(root)
        .filter((file) => INVISIBLE.test(readFileSync(file, 'utf8')));
      assert.deepEqual(
        offenders,
        [],
        `write these as escapes (\\uFEFF etc) so an editor pass cannot change their meaning: ${offenders.join(', ')}`
      );
    });
  }
});
