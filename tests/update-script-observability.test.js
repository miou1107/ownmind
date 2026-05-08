import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.81 — update.ps1 / update.sh 觀測管道補洞 + StackOverflow 根因修法（vin-windows-test 第五輪）
 *
 * Root cause (StackOverflow)：
 *   update.ps1 用 `@"..."@` 雙引號 heredoc 包 node JS 腳本，PS 會對 heredoc 做變數展開。
 *   JS code 含大量 `$(...)` 和 `$變數`，遇上 Set-StrictMode -Version Latest 時某些路徑
 *   會觸發 PS 遞迴展開 → StackOverflowException 整個 process 死。
 *
 *   修法：4 處 heredoc 全改單引號 `@'...'@`，禁止 PS 變數展開。JS code 內所有 `$`、`$()`
 *   原樣保留，由 node 自己 parse。
 *
 * Observability gap (v1.17.79/80 沒覆蓋到的)：
 *   update.ps1 / update.sh 是「skill / hook 同步」的 light path，跟 install / upgrade 並列。
 *   v1.17.79 把 errors/ spool wiring 上去 install + interactive-upgrade，但漏了 update.{ps1,sh}。
 *   所以 vin-windows-test 第五輪：他的 AI 跑 update.ps1（不是 bootstrap），失敗後 server 完全
 *   看不到 — 因為這支沒 beacon、沒 report-error、沒 drain spool。
 *
 *   修法：update.{ps1,sh} 加 beacon (update_started) + try/catch report-error + 結尾 drain。
 *   與 install / upgrade 同等觀測層級。
 */

describe('update.ps1 — heredoc 必須單引號避免 PS 變數展開（v1.17.81 StackOverflow fix）', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'scripts/update.ps1'), 'utf8');

  it('不得有 @"..."@ 雙引號 heredoc（會觸發 PS 變數展開內含 JS 的 $variables）', () => {
    // 雙引號 heredoc 在 PS 內 enable 變數 + subexpression 展開；含 JS code 時危險
    assert.doesNotMatch(
      content,
      /@"\r?\n[\s\S]*?const\s+\w+\s*=/,
      '改成 @\'...\'@ 單引號 heredoc，JS code 才能原樣保留'
    );
  });

  it('保留至少一個 @\'...\'@ 單引號 heredoc（修法已套用的訊號）', () => {
    assert.match(content, /@'\r?\n/, '至少要有一個單引號 heredoc 才算修了');
  });
});

describe('update.ps1 — 觀測管道（v1.17.81 IR-038）', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'scripts/update.ps1'), 'utf8');

  it('開頭送 update_started beacon（同 install_started 模式）', () => {
    assert.match(content, /update_started/, 'beacon trigger 名稱用 update_started');
  });

  it('載入 report-error helper（dot-source）', () => {
    assert.match(content, /report-error\.ps1/, '必須引入 report-error helper');
  });

  it('檔頭明示「不是完整升級，要升級請用 bootstrap」', () => {
    // 防止 AI 助手看到「update」就跑這支當升級用
    assert.match(content, /bootstrap/i, '檔頭至少要提到 bootstrap，引導正確升級路徑');
  });
});

describe('update.sh — 觀測管道（v1.17.81 IR-038）', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'scripts/update.sh'), 'utf8');

  it('開頭送 update_started beacon', () => {
    assert.match(content, /update_started/);
  });

  it('source report-error helper', () => {
    assert.match(content, /report-error\.sh/);
  });

  it('檔頭明示「不是完整升級，要升級請用 bootstrap」', () => {
    assert.match(content, /bootstrap/i);
  });
});
