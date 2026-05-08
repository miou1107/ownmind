import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.80 — install_started beacon 上傳失敗時 spool fallback（vin-windows-test 第四輪）
 *
 * Root cause（v1.17.79 沒守到的下一層）：
 *   - v1.17.78 的 Send-InstallBeacon / send_install_beacon 是 fire-and-forget
 *   - try ... catch { } 把 upload 失敗整個吞掉，沒進 retry 機制
 *   - 真實案例：vin-windows-test 確認自己升到 1.17.78，但 server 完全沒收到任何 beacon
 *     → 升級時的 install.ps1 step 4（re-run install.ps1）的 Send-InstallBeacon 失敗了，
 *     資料就丟了。retrySpool 救不到，因為從來沒進 spool。
 *
 * 修法：beacon POST 失敗時把 body append 到 ~/.ownmind/logs/.upload-spool.jsonl，
 * 下次 self-check 開頭跑 retrySpool() 就會自動補傳。
 */

describe('install.ps1 Send-InstallBeacon — POST 失敗時 spool fallback (v1.17.80)', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'install.ps1'), 'utf8');

  it('Send-InstallBeacon 內含 .upload-spool.jsonl 寫入路徑（beacon 失敗時 spool）', () => {
    // 抓 Send-InstallBeacon function 整個 block，確認裡面有 .upload-spool.jsonl 字串
    const fnMatch = content.match(/function Send-InstallBeacon[\s\S]+?^\}/m);
    assert.ok(fnMatch, '找不到 Send-InstallBeacon function 定義');
    assert.match(
      fnMatch[0],
      /\.upload-spool\.jsonl/,
      'Send-InstallBeacon 必須在失敗時寫入 .upload-spool.jsonl（同 self-check spool）'
    );
  });

  it('用 BOM-less UTF-8 append（複用 v1.17.12 的寫法）', () => {
    const fnMatch = content.match(/function Send-InstallBeacon[\s\S]+?^\}/m);
    assert.ok(fnMatch);
    // 必須走 [System.IO.File]::AppendAllText 或 .NET UTF8Encoding($false)
    // — Add-Content -Encoding UTF8 在 PS 5.1 會加 BOM，下游 Node JSON.parse 炸
    assert.match(
      fnMatch[0],
      /AppendAllText|UTF8Encoding/,
      '必須用 .NET API append 而非 Add-Content（避免 BOM 污染）'
    );
  });
});

describe('install.sh send_install_beacon — POST 失敗時 spool fallback (v1.17.80)', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'install.sh'), 'utf8');

  it('send_install_beacon 內含 .upload-spool.jsonl append 路徑', () => {
    const fnMatch = content.match(/send_install_beacon\(\)\s*\{[\s\S]+?\n\}/m);
    assert.ok(fnMatch, '找不到 send_install_beacon function');
    assert.match(
      fnMatch[0],
      /\.upload-spool\.jsonl/,
      'send_install_beacon 失敗時必須 append 到 .upload-spool.jsonl'
    );
  });

  it('curl 成功才 return；失敗走 spool 路徑', () => {
    const fnMatch = content.match(/send_install_beacon\(\)\s*\{[\s\S]+?\n\}/m);
    assert.ok(fnMatch);
    // 必須有 if curl ... then return 結構
    assert.match(
      fnMatch[0],
      /if\s+curl[\s\S]*?then[\s\S]*?return/,
      'POST 成功要明確 return；失敗才走 spool（避免兩邊都做）'
    );
  });
});
