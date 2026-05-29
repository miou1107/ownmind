import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.12 — install.ps1 must not use Set-Content to write files that need parsing (reported by Adam/Eric)
 *
 * Root cause: PS 5.1's `Set-Content -Encoding UTF8` adds a UTF-8 BOM (EF BB BF).
 * Downstream Node `JSON.parse` / `sh` / `cmd` blow up on a BOM. Mac install.sh uses
 * a heredoc without a BOM, so Mac is fine while Windows is fully broken.
 *
 * This file forces install.ps1 to switch to `[System.IO.File]::WriteAllText`
 * (both PS 5.1/7 emit BOM-less UTF-8) for the following cases:
 *   1. settings.json / mcp.json (JSON.parse would blow up)
 *   2. git hook shell wrapper (/bin/sh blows up on a BOM in the first line)
 */

describe('install.ps1 — do not use Set-Content to write sensitive files', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'install.ps1'), 'utf8');

  it('must not `ConvertTo-Json | Set-Content` (JSON would be polluted by a BOM)', () => {
    assert.doesNotMatch(
      content,
      /ConvertTo-Json[\s\S]{0,60}\|\s*Set-Content/,
      '用 Set-Content -Encoding UTF8 在 PS 5.1 會加 BOM，下游 Node JSON.parse 炸'
    );
  });

  it('must not use heredoc + Set-Content to write the shell wrapper', () => {
    assert.doesNotMatch(
      content,
      /"@\s*\|\s*Set-Content[^|\n]+(PreCommit|PostCommit)[^|\n]*-Encoding\s+UTF8/,
      'git hook shell wrapper 被 BOM 污染會讓 /bin/sh 首行報錯'
    );
  });

  it('uses [System.IO.File]::WriteAllText (BOM-less UTF-8 write)', () => {
    assert.match(
      content,
      /\[System\.IO\.File\]::WriteAllText/,
      '至少一處使用 WriteAllText 才代表已切到 BOM-less 寫法'
    );
  });
});
