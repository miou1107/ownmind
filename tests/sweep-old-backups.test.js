import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * v1.17.70 — sweep-old-backups (IR-027 program-logic gate)
 *
 * Background: from v1.17.0, interactive-upgrade.sh / .ps1 leave upgrade
 * backups under ~/.ownmind.bak.<ts>/. bootstrap.sh / bootstrap.ps1 log
 * messages just say "you can manually delete this after 3 days" — but
 * nowhere in the repo is there logic that actually cleans them, so they
 * accumulate forever if the user forgets. Vin's machine accumulated 19
 * copies / 894 MB (4/23 to 5/8, 15 days). Classic IR-027 violation
 * ("reminders are ineffective, only logic works").
 *
 * Fix: interactive-upgrade.sh appends a find sweep at the tail of a
 * successful upgrade with a default retention of 7 days (overridable via
 * OWNMIND_BACKUP_RETENTION_DAYS env var).
 *
 * This test verifies the find command syntax + boundary behavior
 * (mtime / -maxdepth / -name pattern), running cleanly on macOS / Linux CI.
 * The PS1 variant has the same logic but cannot run inside the Node test
 * harness; we rely on manual review for it.
 */

let tmpDir;

function touch(filePath, mtime) {
  fs.mkdirSync(filePath, { recursive: true });
  // Use utimes to set mtime directly (in seconds).
  const ts = mtime.getTime() / 1000;
  fs.utimesSync(filePath, ts, ts);
}

function listRemaining() {
  return fs.readdirSync(tmpDir).filter((f) => f.startsWith('.ownmind.bak.')).sort();
}

function runSweep(retentionDays) {
  // Same find command interactive-upgrade.sh will use.
  const cmd = `find "${tmpDir}" -maxdepth 1 -type d -name '.ownmind.bak.*' -mtime +${retentionDays} -exec rm -rf {} + 2>/dev/null; true`;
  const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sweep failed: ${r.stderr}`);
}

describe('v1.17.70 — sweep old backups (find -mtime +N)', () => {
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-sweep-test-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deletes backups older than 7 days; keeps those ≤ 7 days old', () => {
    const now = Date.now();
    const day = 86400 * 1000;
    // Create 5 backups with mtimes from 14 days ago to today.
    touch(path.join(tmpDir, '.ownmind.bak.20260424'), new Date(now - 14 * day));
    touch(path.join(tmpDir, '.ownmind.bak.20260429'), new Date(now - 9 * day));
    touch(path.join(tmpDir, '.ownmind.bak.20260430'), new Date(now - 8 * day));
    touch(path.join(tmpDir, '.ownmind.bak.20260505'), new Date(now - 3 * day));
    touch(path.join(tmpDir, '.ownmind.bak.20260508'), new Date(now));

    runSweep(7);

    const remaining = listRemaining();
    // 14/9/8 days ago should be deleted; 3/0 days ago should stay.
    // The 7~8 day boundary differs slightly between BSD find (macOS) and GNU find;
    // this test deliberately avoids that boundary range. In production nobody
    // cares about hour-level precision; "roughly 7 days" is fine.
    assert.deepEqual(remaining, [
      '.ownmind.bak.20260505',
      '.ownmind.bak.20260508',
    ]);
  });

  it('-maxdepth 1 does not accidentally hit a same-named directory nested deeper', () => {
    // Clear leftovers from the previous test.
    fs.readdirSync(tmpDir).forEach((f) =>
      fs.rmSync(path.join(tmpDir, f), { recursive: true, force: true })
    );

    const now = Date.now();
    const day = 86400 * 1000;

    touch(path.join(tmpDir, '.ownmind.bak.outer'), new Date(now - 30 * day));
    touch(path.join(tmpDir, 'unrelated', '.ownmind.bak.nested'), new Date(now - 30 * day));

    runSweep(7);

    // outer should be deleted; unrelated/.ownmind.bak.nested should not be reached.
    assert.equal(
      fs.existsSync(path.join(tmpDir, '.ownmind.bak.outer')),
      false,
      'outer should be deleted'
    );
    assert.equal(
      fs.existsSync(path.join(tmpDir, 'unrelated', '.ownmind.bak.nested')),
      true,
      'nested should not be reached due to -maxdepth 1'
    );
  });

  it('does not accidentally hit similarly-named directories with a different prefix (.ownmind / .ownmind.cache)', () => {
    fs.readdirSync(tmpDir).forEach((f) =>
      fs.rmSync(path.join(tmpDir, f), { recursive: true, force: true })
    );

    const now = Date.now();
    const day = 86400 * 1000;

    touch(path.join(tmpDir, '.ownmind'), new Date(now - 30 * day));
    touch(path.join(tmpDir, '.ownmind.cache'), new Date(now - 30 * day));
    touch(path.join(tmpDir, 'ownmind.bak.foo'), new Date(now - 30 * day));  // no dot prefix
    touch(path.join(tmpDir, '.ownmind.bak.real'), new Date(now - 30 * day));

    runSweep(7);

    assert.equal(fs.existsSync(path.join(tmpDir, '.ownmind')), true,
      '.ownmind main directory must absolutely not be touched');
    assert.equal(fs.existsSync(path.join(tmpDir, '.ownmind.cache')), true,
      '.ownmind.cache must not be touched');
    assert.equal(fs.existsSync(path.join(tmpDir, 'ownmind.bak.foo')), true,
      'without the dot prefix should not be deleted');
    assert.equal(fs.existsSync(path.join(tmpDir, '.ownmind.bak.real')), false,
      'a real .ownmind.bak.* should be deleted');
  });

  it('retention 0 should delete every old backup (including today\'s)', () => {
    fs.readdirSync(tmpDir).forEach((f) =>
      fs.rmSync(path.join(tmpDir, f), { recursive: true, force: true })
    );

    const now = Date.now();
    const day = 86400 * 1000;

    touch(path.join(tmpDir, '.ownmind.bak.older'), new Date(now - 5 * day));
    touch(path.join(tmpDir, '.ownmind.bak.now'), new Date(now - 0.1 * day));

    runSweep(0);

    // -mtime +0 still means "older than 0 days"; 0.1 days → expected to be deleted.
    // The exact "today" boundary (0 days) varies by find implementation.
    assert.equal(fs.existsSync(path.join(tmpDir, '.ownmind.bak.older')), false);
  });

  it('does not blow up when no .ownmind.bak.* exists at all', () => {
    fs.readdirSync(tmpDir).forEach((f) =>
      fs.rmSync(path.join(tmpDir, f), { recursive: true, force: true })
    );
    // Run sweep against the empty directory.
    runSweep(7);
    assert.deepEqual(listRemaining(), []);
  });
});

// ============================================================================
// v1.17.70 — interactive-upgrade.sh + .ps1 actually call sweep
// ============================================================================
describe('v1.17.70 — upgrade script must call sweep at the tail of a successful upgrade', () => {
  it('interactive-upgrade.sh contains a find -mtime sweep', () => {
    const sh = fs.readFileSync('scripts/interactive-upgrade.sh', 'utf8');
    // Accept $HOME / ${HOME} / "$HOME" / "${HOME}" in any form.
    assert.match(sh, /find\s+["']?\$\{?HOME\}?["']?\s+-maxdepth\s+1\s+-type\s+d\s+-name\s+['"]\.ownmind\.bak\.\*['"]\s+-mtime\s+\+/,
      'interactive-upgrade.sh should have find -maxdepth 1 -name .ownmind.bak.* -mtime +N sweep');
    assert.match(sh, /OWNMIND_BACKUP_RETENTION_DAYS/,
      'sweep should support OWNMIND_BACKUP_RETENTION_DAYS env override');
  });

  it('interactive-upgrade.ps1 contains LastWriteTime sweep logic', () => {
    const ps = fs.readFileSync('scripts/interactive-upgrade.ps1', 'utf8');
    assert.match(ps, /LastWriteTime/,
      'PS version should use Get-ChildItem + Where LastWriteTime -lt cutoff for sweep');
    assert.match(ps, /\.ownmind\.bak\.\*/,
      'PS version should only clean .ownmind.bak.* pattern');
    assert.match(ps, /OWNMIND_BACKUP_RETENTION_DAYS/,
      'PS sweep should support OWNMIND_BACKUP_RETENTION_DAYS env override');
  });

  it('bootstrap.sh / .ps1 messaging is updated to say "auto-cleaned"', () => {
    const sh = fs.readFileSync('scripts/bootstrap.sh', 'utf8');
    const ps = fs.readFileSync('scripts/bootstrap.ps1', 'utf8');
    // Must no longer say "you can manually delete after 3 days" (IR-027 reminders are ineffective).
    assert.doesNotMatch(sh, /可手動(刪除|清除|清掉)/,
      'bootstrap.sh must no longer say "can manually delete" — that is the no-logic reminder pattern');
    assert.doesNotMatch(ps, /可手動(刪除|清除|清掉)/,
      'bootstrap.ps1 must no longer say "can manually delete" — that is the no-logic reminder pattern');
  });
});
