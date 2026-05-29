import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * When Windows PowerShell 5.1 (still the Windows 10 default) reads a .ps1 file, a missing BOM
 * causes it to interpret the file with the system codepage. On Traditional-Chinese Windows,
 * CP950 mis-maps UTF-8 Chinese bytes — at best producing garbled text, at worst hitting
 * PowerShell reserved characters (like backticks or quotes) and failing the parser outright.
 *
 * Any .ps1 containing Chinese must be UTF-8 with BOM (EF BB BF). PowerShell 7+ defaults to
 * UTF-8 without BOM, but PowerShell 5.1 needs the BOM to "force" the UTF-8 path. The BOM is a
 * no-op for 7+ with no side effects, so always adding the BOM is the safest choice.
 *
 * This file reads the bytes via Buffer and checks the first three bytes to avoid string-parsing bypass issues.
 */

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function collectPs1Files(dir) {
  const out = [];
  const queue = [dir];
  while (queue.length > 0) {
    const current = queue.shift();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) queue.push(full);
      else if (ent.isFile() && ent.name.endsWith('.ps1')) out.push(full);
    }
  }
  return out;
}

function hasChinese(buf) {
  // Rough UTF-8 Chinese check: bytes E4-E9 as lead, followed by 80-BF x2
  for (let i = 0; i < buf.length - 2; i++) {
    const b = buf[i];
    if (b >= 0xe4 && b <= 0xe9 && (buf[i + 1] & 0xc0) === 0x80 && (buf[i + 2] & 0xc0) === 0x80) {
      return true;
    }
  }
  return false;
}

describe('PS1 UTF-8 BOM enforcement', () => {
  const ps1Files = collectPs1Files(repoRoot);

  it('at least one .ps1 file is found in the repo', () => {
    assert.ok(ps1Files.length > 0, `no .ps1 found in ${repoRoot}`);
  });

  for (const file of ps1Files) {
    const rel = path.relative(repoRoot, file);
    const buf = fs.readFileSync(file);

    it(`${rel} — must start with a UTF-8 BOM`, () => {
      if (!hasChinese(buf)) {
        // English-only files are not required to have a BOM, but this will fail once Chinese is added
        return;
      }
      const actualHead = buf.slice(0, 3);
      assert.ok(
        actualHead.equals(UTF8_BOM),
        `${rel} 含中文但沒 UTF-8 BOM\n` +
        `前 3 byte: ${[...actualHead].map(b => b.toString(16).padStart(2, '0')).join(' ')}`
      );
    });
  }
});
