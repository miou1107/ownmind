import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.10 — install.ps1 Copy-Item self-overwrite guard (reported by Bob)
 *
 * $OwnmindDir = $HOME\.ownmind and dest $HOME\.ownmind\shared\ are the same
 * location after git clone — Copy-Item tries to "copy itself onto itself" and
 * emits 4 red warnings (harmless but noisy, and makes users think the install
 * failed). install.sh guards with `-ef`; install.ps1 does not.
 */

describe('install.ps1 — Copy-Item self-overwrite guard', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'install.ps1'), 'utf8');

  it('verification.js must compare resolved paths before copying', () => {
    // Accept two common forms: GetFullPath comparison OR if($src -ne $dst) with Resolve-Path
    // Also accept simply removing the Copy-Item (git clone already put it there)
    const hasGuard =
      /GetFullPath|Resolve-Path.*\$VerificationSrc|\$VerificationSrc\s+-ne|SrcFull\s*=|\$srcResolved/.test(content);
    const copyLineRegex = /Copy-Item\s+\$VerificationSrc/;
    const hasCopy = copyLineRegex.test(content);
    assert.ok(
      !hasCopy || hasGuard,
      'install.ps1 仍對 $VerificationSrc 做無條件 Copy-Item → 會跟 $OwnmindDir 自我複製'
    );
  });

  it('git hook JS files must compare resolved paths before copying', () => {
    // Check whether the Copy-Item $src inside the foreach loop has a comparison
    const loopBlock = content.match(
      /foreach\s*\(\s*\$jsFile[^)]+\)\s*\{[\s\S]*?Copy-Item[\s\S]*?\}/
    );
    if (!loopBlock) {
      // No loop found means it was refactored away, OK
      return;
    }
    const block = loopBlock[0];
    const hasGuard =
      /GetFullPath|Resolve-Path|\$srcResolved|\$src\s+-ne|-ef/.test(block);
    assert.ok(
      hasGuard,
      'install.ps1 git hook copy loop 沒做 src/dest 同路徑檢查 → 4 次自我複製警告'
    );
  });
});
