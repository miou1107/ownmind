import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * A file URL is built with `pathToFileURL`, never by writing `file://` in front of a path.
 *
 * The idiom this forbids is the entry-point check every CLI in this repository carries:
 *
 *     import.meta.url === `file://${process.argv[1]}`
 *
 * On POSIX that is true, and true by accident — argv[1] is `/repo/x.mjs`, and its leading
 * slash supplies the third slash a `file:///` URL needs. On Windows argv[1] is `C:\repo\x.mjs`
 * and the result is `file://C:\repo\x.mjs`, which equals nothing. The comparison is simply
 * always false there.
 *
 * What that costs is not an error. `client/src/scripts/translate.mjs` ran on Windows, matched
 * nothing, printed nothing, wrote nothing and exited 0 — reporting success for work it had not
 * done. It was found on 2026-08-15 only because a test asserted on its output. A second copy
 * sat in `hooks/lib/sync-memory-files.js`, correct by luck: nothing on Windows invokes that
 * file as a CLI today.
 *
 * Two occurrences of one mistake, one of them harmless for a reason nobody chose. That is what
 * this guard is for — not the two that were fixed, but the third.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const SEARCHED = ['hooks', 'shared', 'src', 'mcp', 'scripts', 'client/src', 'tests'];
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

// `file://` immediately followed by a template placeholder or a concatenation — the shapes that
// build a URL out of a path. A literal `file:///abs/path` in a comment or a string is fine and
// is not matched.
const CONCATENATED = /file:\/\/(\$\{|['"]\s*\+|`\s*\+)/;

function sourceFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

describe('no file URL is built by concatenation', () => {
  it('every source file uses pathToFileURL instead', () => {
    const offenders = [];
    for (const dir of SEARCHED) {
      for (const file of sourceFiles(path.join(repoRoot, dir))) {
        const rel = path.relative(repoRoot, file).replace(/\\/g, '/');
        if (rel === 'tests/no-file-url-concatenation.test.js') continue;
        const src = fs.readFileSync(file, 'utf8');
        src.split('\n').forEach((line, i) => {
          // Comments are skipped, and this is not a loophole — it is the only way the fixes
          // can explain themselves. Every place this was corrected carries a comment naming
          // the wrong form so the next reader knows what not to write, and a guard that reads
          // those as violations makes the explanation unwritable.
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
          if (CONCATENATED.test(line)) offenders.push(`${rel}:${i + 1}`);
        });
      }
    }

    assert.deepEqual(offenders, [],
      `${offenders.length} place(s) build a file URL by concatenation: ${offenders.join(', ')}. `
      + 'Use pathToFileURL(p).href. On Windows the concatenated form is never equal to '
      + 'import.meta.url, and the script it guards becomes a silent no-op that still exits 0.');
  });

  it('states the premise it is guarding, on this platform', () => {
    // Without this the rule is folklore. On Windows the two forms genuinely differ; on POSIX
    // they happen to agree, and saying so is what stops someone reading this file on a Mac and
    // concluding the guard is pedantry.
    const sample = process.platform === 'win32' ? 'C:\\repo\\x.mjs' : '/repo/x.mjs';
    const correct = pathToFileURL(sample).href;
    const concatenated = `file://${sample}`;

    if (process.platform === 'win32') {
      assert.notEqual(concatenated, correct,
        'on Windows these must differ — if they no longer do, this guard can be deleted');
    } else {
      assert.equal(concatenated, correct,
        'on POSIX they agree, which is exactly why the mistake survives review here');
    }
  });
});
