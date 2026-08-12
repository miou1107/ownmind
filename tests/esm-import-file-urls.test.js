import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * v1.26.108 — `await import(someAbsolutePath)` is broken on Windows, and it was broken in ten
 * places at once.
 *
 * The ESM loader takes a module specifier, and an absolute filesystem path is only
 * accidentally one. `/Users/x/.ownmind/shared/verification.js` happens to parse; the same
 * file on Windows is `C:\Users\x\.ownmind\shared\verification.js`, whose leading `C:` the
 * loader reads as a URL scheme and rejects with ERR_UNSUPPORTED_ESM_URL_SCHEME.
 *
 * Every one of the ten sites wrapped the import in a `catch` that carried on — printing
 * "Validator engine unavailable" at best, exiting 0 silently at worst. So on Windows the
 * rule engine behind the pre-commit secret scan, the commit-message rules, the post-commit
 * check and the iron-rule check was never loaded, and nothing said so. The hardcoded
 * `Co-Authored-By` guard kept firing, which is why the hooks still looked alive.
 *
 * These two cases are the guard, and neither of them needs Windows to run. That is the
 * point: the defect is a property of the string being passed, not of the machine reading
 * it, so it can be checked from the Mac where the code is written.
 */

const SCANNED_DIRS = ['hooks', 'shared', 'src', 'mcp', 'scripts', 'client/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'public']);

function* sourceFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // an optional directory that does not exist here
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* sourceFiles(full);
    } else if (/\.(m?js|cjs|jsx)$/.test(entry.name)) {
      yield full;
    }
  }
}

/**
 * A specifier is safe when it is a literal — './x.js', 'node:fs', 'node-machine-id' — or when
 * it has been turned into a URL. Anything else is an expression producing a path at runtime,
 * and a path is exactly what the loader will not take.
 */
function isSafeSpecifier(arg) {
  const trimmed = arg.trim();
  if (/^['"`]/.test(trimmed) && !trimmed.startsWith("'/") && !trimmed.startsWith('"/')) return true;
  return /pathToFileURL|\.href\b|^toUrl\(/.test(trimmed);
}

describe('v1.26.108 — dynamic import takes URLs, not Windows paths', () => {
  it('no shipped file passes a runtime path straight to import()', () => {
    const offenders = [];

    for (const dir of SCANNED_DIRS) {
      for (const file of sourceFiles(path.join(repoRoot, dir))) {
        const src = fs.readFileSync(file, 'utf8');
        const lines = src.split('\n');

        lines.forEach((line, i) => {
          // Prose about import() is not a call. Comments explaining this very rule live in
          // the files this test scans, so skipping them is required, not merely tidy.
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;

          for (const m of line.matchAll(/(?<![.\w])import\s*\(([^)]*)\)/g)) {
            const arg = m[1];
            if (!arg.trim()) continue;
            if (isSafeSpecifier(arg)) continue;
            offenders.push(`${path.relative(repoRoot, file)}:${i + 1}  import(${arg.trim()})`);
          }
        });
      }
    }

    assert.deepEqual(
      offenders, [],
      'these pass a runtime path to import(). On Windows the drive letter is read as a URL '
        + 'scheme and the import throws ERR_UNSUPPORTED_ESM_URL_SCHEME; wrap the path in '
        + `pathToFileURL(p).href.\n  ${offenders.join('\n  ')}`,
    );
  });

  it('pathToFileURL is what makes an absolute path importable', async () => {
    // The positive half. Without it the case above is only a spelling rule, and a spelling
    // rule nobody has watched work is a rule that can be right about the wrong thing.
    const dir = tempDir('ownmind-esm-');
    const file = path.join(dir, 'verification.js');
    try {
      fs.writeFileSync(file, 'export const evaluateConditions = () => "loaded";\n');

      const href = pathToFileURL(file).href;
      assert.match(href, /^file:\/\//, 'pathToFileURL did not produce a file URL');

      const mod = await import(href);
      assert.equal(mod.evaluateConditions(), 'loaded', 'the file URL form did not import');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
