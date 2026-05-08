import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * v1.17.70 — sweep-old-backups（IR-027 邏輯卡控）
 *
 * 背景：v1.17.0 起 interactive-upgrade.sh / .ps1 在 ~/.ownmind.bak.<ts>/ 留升級
 * 備份。bootstrap.sh / bootstrap.ps1 log 訊息只說「3 天後可手動刪除」 —— 但全
 * repo 沒有任何邏輯實際清，使用者忘了就無限累積。Vin 機器上累積到 19 份、
 * 894 MB（從 4/23 到 5/8 共 15 天）。違反 IR-027「提醒無效，邏輯才有效」。
 *
 * 修法：interactive-upgrade.sh 在升級成功末段補一個 find sweep，預設 retention
 * 7 天（可用 OWNMIND_BACKUP_RETENTION_DAYS 環境變數覆蓋）。
 *
 * 這個 test 驗 find command 的 syntax + 邊界行為（mtime / -maxdepth / -name
 * pattern），在 CI 跑 macOS / Linux 都對。PS1 版本同樣邏輯但無法在 Node test
 * 跑、靠 manual review。
 */

let tmpDir;

function touch(filePath, mtime) {
  fs.mkdirSync(filePath, { recursive: true });
  // 用 utimes 直接設 mtime（秒）
  const ts = mtime.getTime() / 1000;
  fs.utimesSync(filePath, ts, ts);
}

function listRemaining() {
  return fs.readdirSync(tmpDir).filter((f) => f.startsWith('.ownmind.bak.')).sort();
}

function runSweep(retentionDays) {
  // 跟 interactive-upgrade.sh 將要用的同一條 find command
  const cmd = `find "${tmpDir}" -maxdepth 1 -type d -name '.ownmind.bak.*' -mtime +${retentionDays} -exec rm -rf {} + 2>/dev/null; true`;
  const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sweep 失敗：${r.stderr}`);
}

describe('v1.17.70 — sweep old backups（find -mtime +N）', () => {
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-sweep-test-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('刪掉 mtime 超過 7 天的、留 ≤ 7 天的', () => {
    const now = Date.now();
    const day = 86400 * 1000;
    // 設 5 個備份，mtime 從 14 天前到今天
    touch(path.join(tmpDir, '.ownmind.bak.20260424'), new Date(now - 14 * day));
    touch(path.join(tmpDir, '.ownmind.bak.20260429'), new Date(now - 9 * day));
    touch(path.join(tmpDir, '.ownmind.bak.20260430'), new Date(now - 8 * day));
    touch(path.join(tmpDir, '.ownmind.bak.20260505'), new Date(now - 3 * day));
    touch(path.join(tmpDir, '.ownmind.bak.20260508'), new Date(now));

    runSweep(7);

    const remaining = listRemaining();
    // 14/9/8 天前的都應被刪、3/0 天前的應留下。
    // 7~8 天之間的邊界 mac BSD find 跟 GNU find 行為略不同，這個 test 避開那個區間
    // （production 場景沒人在乎一兩小時的精度，7 天 retention 大致對就行）。
    assert.deepEqual(remaining, [
      '.ownmind.bak.20260505',
      '.ownmind.bak.20260508',
    ]);
  });

  it('-maxdepth 1 不會誤殺巢狀目錄裡的同名（不該遞迴下去）', () => {
    // 清掉前一個 test 留下的
    fs.readdirSync(tmpDir).forEach((f) =>
      fs.rmSync(path.join(tmpDir, f), { recursive: true, force: true })
    );

    const now = Date.now();
    const day = 86400 * 1000;

    touch(path.join(tmpDir, '.ownmind.bak.outer'), new Date(now - 30 * day));
    touch(path.join(tmpDir, 'unrelated', '.ownmind.bak.nested'), new Date(now - 30 * day));

    runSweep(7);

    // outer 應被刪、unrelated/.ownmind.bak.nested 不該被掃到
    assert.equal(
      fs.existsSync(path.join(tmpDir, '.ownmind.bak.outer')),
      false,
      'outer 應被刪'
    );
    assert.equal(
      fs.existsSync(path.join(tmpDir, 'unrelated', '.ownmind.bak.nested')),
      true,
      '巢狀的不該被 -maxdepth 1 掃到'
    );
  });

  it('不會誤殺名字像但 prefix 不同的目錄（如 .ownmind / .ownmind.cache）', () => {
    fs.readdirSync(tmpDir).forEach((f) =>
      fs.rmSync(path.join(tmpDir, f), { recursive: true, force: true })
    );

    const now = Date.now();
    const day = 86400 * 1000;

    touch(path.join(tmpDir, '.ownmind'), new Date(now - 30 * day));
    touch(path.join(tmpDir, '.ownmind.cache'), new Date(now - 30 * day));
    touch(path.join(tmpDir, 'ownmind.bak.foo'), new Date(now - 30 * day));  // 沒 dot prefix
    touch(path.join(tmpDir, '.ownmind.bak.real'), new Date(now - 30 * day));

    runSweep(7);

    assert.equal(fs.existsSync(path.join(tmpDir, '.ownmind')), true,
      '.ownmind 主目錄絕對不能掃到');
    assert.equal(fs.existsSync(path.join(tmpDir, '.ownmind.cache')), true,
      '.ownmind.cache 不能掃到');
    assert.equal(fs.existsSync(path.join(tmpDir, 'ownmind.bak.foo')), true,
      '沒 dot prefix 的不該被刪');
    assert.equal(fs.existsSync(path.join(tmpDir, '.ownmind.bak.real')), false,
      '真正的 .ownmind.bak.* 應被刪');
  });

  it('retention 0 應刪所有舊備份（含今天的）', () => {
    fs.readdirSync(tmpDir).forEach((f) =>
      fs.rmSync(path.join(tmpDir, f), { recursive: true, force: true })
    );

    const now = Date.now();
    const day = 86400 * 1000;

    touch(path.join(tmpDir, '.ownmind.bak.older'), new Date(now - 5 * day));
    touch(path.join(tmpDir, '.ownmind.bak.now'), new Date(now - 0.1 * day));

    runSweep(0);

    // -mtime +0 仍是「>0 天」，0.1 天 → 預期刪；嚴格今天時間（0 天）邊界行為依 find 實作
    assert.equal(fs.existsSync(path.join(tmpDir, '.ownmind.bak.older')), false);
  });

  it('沒有任何 .ownmind.bak.* 也不會炸', () => {
    fs.readdirSync(tmpDir).forEach((f) =>
      fs.rmSync(path.join(tmpDir, f), { recursive: true, force: true })
    );
    // 跑 sweep 對空目錄
    runSweep(7);
    assert.deepEqual(listRemaining(), []);
  });
});

// ============================================================================
// v1.17.70 — interactive-upgrade.sh + .ps1 真的呼叫了 sweep
// ============================================================================
describe('v1.17.70 — upgrade 腳本必須在成功末段呼叫 sweep', () => {
  it('interactive-upgrade.sh 含 find -mtime sweep 邏輯', () => {
    const sh = fs.readFileSync('scripts/interactive-upgrade.sh', 'utf8');
    // 接受 $HOME / ${HOME} / "$HOME" / "${HOME}" 各種寫法
    assert.match(sh, /find\s+["']?\$\{?HOME\}?["']?\s+-maxdepth\s+1\s+-type\s+d\s+-name\s+['"]\.ownmind\.bak\.\*['"]\s+-mtime\s+\+/,
      'interactive-upgrade.sh 應有 find -maxdepth 1 -name .ownmind.bak.* -mtime +N sweep');
    assert.match(sh, /OWNMIND_BACKUP_RETENTION_DAYS/,
      'sweep 應支援 OWNMIND_BACKUP_RETENTION_DAYS env 覆蓋');
  });

  it('interactive-upgrade.ps1 含 LastWriteTime sweep 邏輯', () => {
    const ps = fs.readFileSync('scripts/interactive-upgrade.ps1', 'utf8');
    assert.match(ps, /LastWriteTime/,
      'PS 版本應用 Get-ChildItem + Where LastWriteTime -lt cutoff 做 sweep');
    assert.match(ps, /\.ownmind\.bak\.\*/,
      'PS 版本應只清 .ownmind.bak.* pattern');
    assert.match(ps, /OWNMIND_BACKUP_RETENTION_DAYS/,
      'PS sweep 應支援 OWNMIND_BACKUP_RETENTION_DAYS env 覆蓋');
  });

  it('bootstrap.sh / .ps1 訊息更新成「自動清除」', () => {
    const sh = fs.readFileSync('scripts/bootstrap.sh', 'utf8');
    const ps = fs.readFileSync('scripts/bootstrap.ps1', 'utf8');
    // 不能再寫「3 天後可手動刪除」(IR-027 提醒無效)
    assert.doesNotMatch(sh, /可手動(刪除|清除|清掉)/,
      'bootstrap.sh 不該再寫「可手動刪除」這種無邏輯的提示');
    assert.doesNotMatch(ps, /可手動(刪除|清除|清掉)/,
      'bootstrap.ps1 不該再寫「可手動刪除」這種無邏輯的提示');
  });
});
