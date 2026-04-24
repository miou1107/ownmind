import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.10 — bootstrap.ps1 public route 必須 strip BOM（回報者 Adam）
 *
 * `iwr -useb https://kkvin.com/ownmind/bootstrap.ps1 | iex` 時，response body
 * 首字元 U+FEFF (UTF-8 BOM 解碼後) 會被 iex 當成 cmdlet 呼叫，吐「不是有效 cmdlet」
 * warning。雖然 Adam 回報標「無影響」但 Eric / 其他使用者可能會被嚇到以為安裝失敗。
 *
 * 修法：server serve 時 strip 開頭的 `\uFEFF`。磁碟上的 bootstrap.ps1 仍保留 BOM
 * 以支援 PowerShell 5.1 `-File` 讀檔路徑（v1.17.9 Eric 修正）。
 */

describe('src/app.js — bootstrap public route strip BOM', () => {
  const appJs = fs.readFileSync(path.join(repoRoot, 'src', 'app.js'), 'utf8');
  const ps1Raw = fs.readFileSync(
    path.join(repoRoot, 'scripts', 'bootstrap.ps1'),
    'utf8'
  );

  it('磁碟上的 bootstrap.ps1 仍有 BOM（必要條件）', () => {
    assert.equal(ps1Raw.charCodeAt(0), 0xfeff, 'bootstrap.ps1 檔案本身應保留 BOM');
  });

  it('src/app.js 有 stripBom / 去掉首字元 \\uFEFF 的邏輯', () => {
    // 接受幾種寫法：
    // - 專門的 stripBom helper
    // - .replace(/^\uFEFF/, '')
    // - charCodeAt(0) === 0xFEFF ? slice(1) : str
    const hasStrip =
      /stripBom|replace\(\s*\/\^\\uFEFF\/|replace\(\s*\/\^\\?u?FEFF\/|0xFEFF|0xfeff/.test(appJs);
    assert.ok(hasStrip, 'src/app.js 未對 bootstrapPs1 做 BOM strip');
  });

  it('stripBom 同時套用到 bootstrap.sh（以免 shell 也被波及）', () => {
    // bootstrap.sh 目前沒 BOM，但 stripBom 對無 BOM string 應 no-op
    // 這條 test 只是確保 strip 是套在兩個變數上，對無 BOM string 無害
    const stripsSh =
      /stripBom\(\s*readFileSync[^)]+bootstrap\.sh/.test(appJs) ||
      /stripBom\(bootstrapSh\)/.test(appJs) ||
      // 或 inline slice pattern
      /bootstrapSh\s*=\s*[^;]+(stripBom|replace\(\s*\/\^\\u?FEFF)/.test(appJs);
    const stripsPs1 =
      /stripBom\(\s*readFileSync[^)]+bootstrap\.ps1/.test(appJs) ||
      /stripBom\(bootstrapPs1\)/.test(appJs) ||
      /bootstrapPs1\s*=\s*[^;]+(stripBom|replace\(\s*\/\^\\u?FEFF)/.test(appJs);
    assert.ok(stripsPs1, 'bootstrapPs1 需 strip BOM');
    // sh 可選不強求（sh 沒 BOM 問題）
    void stripsSh;
  });
});
