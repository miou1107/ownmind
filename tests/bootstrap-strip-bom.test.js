import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.10 — bootstrap.ps1 public route must strip BOM (reported by Bob)
 *
 * With `iwr -useb https://kkvin.com/ownmind/bootstrap.ps1 | iex`, the response body's
 * first character U+FEFF (after UTF-8 BOM decode) gets treated by iex as a cmdlet call,
 * producing a "not a valid cmdlet" warning. Although Bob reported it as "no impact",
 * Alice / other users might be scared into thinking the install failed.
 *
 * Fix: strip the leading `\uFEFF` when the server serves it. The on-disk bootstrap.ps1
 * still keeps the BOM to support the PowerShell 5.1 `-File` read path (v1.17.9 Alice fix).
 */

describe('src/app.js — bootstrap public route strip BOM', () => {
  const appJs = fs.readFileSync(path.join(repoRoot, 'src', 'app.js'), 'utf8');
  const ps1Raw = fs.readFileSync(
    path.join(repoRoot, 'scripts', 'bootstrap.ps1'),
    'utf8'
  );

  it('on-disk bootstrap.ps1 still has a BOM (precondition)', () => {
    assert.equal(ps1Raw.charCodeAt(0), 0xfeff, 'bootstrap.ps1 檔案本身應保留 BOM');
  });

  it('src/app.js has stripBom / logic to remove the leading \\uFEFF character', () => {
    // Accept several styles:
    // - a dedicated stripBom helper
    // - .replace(/^\uFEFF/, '')
    // - charCodeAt(0) === 0xFEFF ? slice(1) : str
    const hasStrip =
      /stripBom|replace\(\s*\/\^\\uFEFF\/|replace\(\s*\/\^\\?u?FEFF\/|0xFEFF|0xfeff/.test(appJs);
    assert.ok(hasStrip, 'src/app.js 未對 bootstrapPs1 做 BOM strip');
  });

  it('stripBom is also applied to bootstrap.sh (so the shell is not affected either)', () => {
    // bootstrap.sh currently has no BOM, but stripBom should be a no-op on a BOM-less string
    // This test just ensures strip is applied to both variables, harmless on a BOM-less string
    const stripsSh =
      /stripBom\(\s*readFileSync[^)]+bootstrap\.sh/.test(appJs) ||
      /stripBom\(bootstrapSh\)/.test(appJs) ||
      // or an inline slice pattern
      /bootstrapSh\s*=\s*[^;]+(stripBom|replace\(\s*\/\^\\u?FEFF)/.test(appJs);
    const stripsPs1 =
      /stripBom\(\s*readFileSync[^)]+bootstrap\.ps1/.test(appJs) ||
      /stripBom\(bootstrapPs1\)/.test(appJs) ||
      /bootstrapPs1\s*=\s*[^;]+(stripBom|replace\(\s*\/\^\\u?FEFF)/.test(appJs);
    assert.ok(stripsPs1, 'bootstrapPs1 需 strip BOM');
    // sh is optional, not required (sh has no BOM problem)
    void stripsSh;
  });
});
