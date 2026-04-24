import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.12 — install.ps1 不得用 Set-Content 寫需要被 parse 的檔（回報者 Adam/Eric）
 *
 * Root cause：PS 5.1 的 `Set-Content -Encoding UTF8` 會加 UTF-8 BOM (EF BB BF)。
 * 下游 Node `JSON.parse` / `sh` / `cmd` 遇到 BOM 會炸。Mac install.sh 走 heredoc
 * 不帶 BOM，所以 Mac 沒事、Windows 全壞。
 *
 * 本檔強制 install.ps1 對以下場景改用 `[System.IO.File]::WriteAllText`
 * （PS 5.1/7 都吐 BOM-less UTF-8）：
 *   1. settings.json / mcp.json（JSON.parse 會炸）
 *   2. git hook shell wrapper（/bin/sh 遇到 BOM 首行會炸）
 */

describe('install.ps1 — 不用 Set-Content 寫敏感檔', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'install.ps1'), 'utf8');

  it('不得 `ConvertTo-Json | Set-Content`（JSON 會被 BOM 污染）', () => {
    assert.doesNotMatch(
      content,
      /ConvertTo-Json[\s\S]{0,60}\|\s*Set-Content/,
      '用 Set-Content -Encoding UTF8 在 PS 5.1 會加 BOM，下游 Node JSON.parse 炸'
    );
  });

  it('不得 heredoc + Set-Content 寫 shell wrapper', () => {
    assert.doesNotMatch(
      content,
      /"@\s*\|\s*Set-Content[^|\n]+(PreCommit|PostCommit)[^|\n]*-Encoding\s+UTF8/,
      'git hook shell wrapper 被 BOM 污染會讓 /bin/sh 首行報錯'
    );
  });

  it('有用 [System.IO.File]::WriteAllText (BOM-less UTF-8 寫法)', () => {
    assert.match(
      content,
      /\[System\.IO\.File\]::WriteAllText/,
      '至少一處使用 WriteAllText 才代表已切到 BOM-less 寫法'
    );
  });
});
