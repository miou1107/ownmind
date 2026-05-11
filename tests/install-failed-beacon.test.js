import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.85 — interactive-upgrade FAIL 函式統一補 report_error（IR-038 觀測盲點補強）
 *
 * 背景：Adam (id=3) / Michelle (id=6) 5/10-11 跑 update_started beacon 之後沒任何
 * post_install 報告 → 升級顯然失敗、但 errors/ spool 一條紀錄都沒寫。Trace 發現
 * interactive-upgrade.sh 雖然多數 FAIL path 之前有 call report_error，但仍有漏網
 * (no_ownmind / no_git / cd_failed / install / verify_local 等)，加上 unexpected
 * exit (syntax error / SIGTERM / unset var) 完全沒人攔。
 *
 * 修法：FAIL 函式本身統一補 fallback report_error，避免依賴每個 caller 都記得先打。
 */

describe('v1.17.85 — interactive-upgrade.sh FAIL 觸發時自動寫 errors/ 觀測', () => {
  let tmpHome;
  let errorsDir;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-fail-beacon-'));
    // 把 report-error helper + report-error.sh 鏡像到 tmpHome 模擬使用者 .ownmind
    const ownmindDir = path.join(tmpHome, '.ownmind');
    fs.mkdirSync(path.join(ownmindDir, 'scripts', 'install-helpers'), { recursive: true });
    fs.mkdirSync(path.join(ownmindDir, 'logs', 'errors'), { recursive: true });
    fs.copyFileSync(
      path.join(repoRoot, 'scripts/install-helpers/report-error.cjs'),
      path.join(ownmindDir, 'scripts/install-helpers/report-error.cjs')
    );
    fs.copyFileSync(
      path.join(repoRoot, 'scripts/install-helpers/report-error.sh'),
      path.join(ownmindDir, 'scripts/install-helpers/report-error.sh')
    );
    errorsDir = path.join(ownmindDir, 'logs', 'errors');
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  // 抽小寫一個會 call FAIL 的最小化 stub，引用真的 interactive-upgrade.sh FAIL 函式
  function runMinimalUpgradeWithFail(failCode, failMsg) {
    const fakeUpgrade = `
      #!/usr/bin/env bash
      set -u
      OWNMIND_DIR="${path.join(tmpHome, '.ownmind')}"
      LOG_FILE="\${OWNMIND_DIR}/logs/upgrade-test.log"
      touch "\${LOG_FILE}"

      # source report-error helper（同 interactive-upgrade.sh 開頭）
      if [ -f "\${OWNMIND_DIR}/scripts/install-helpers/report-error.sh" ]; then
        . "\${OWNMIND_DIR}/scripts/install-helpers/report-error.sh"
      else
        report_error() { :; }
      fi

      # ↓ 從真的 interactive-upgrade.sh 拷貝 FAIL 函式 ↓
      eval "$(sed -n '/^FAIL()/,/^}/p' "${path.join(repoRoot, 'scripts/interactive-upgrade.sh')}")"

      FAIL "${failCode}" "${failMsg}"
    `;
    const result = spawnSync('bash', ['-c', fakeUpgrade], {
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
      encoding: 'utf8',
    });
    return result;
  }

  it('呼叫 FAIL "no_ownmind" 時，errors/ 自動寫一筆觀測 record', () => {
    const r = runMinimalUpgradeWithFail('no_ownmind', 'OwnMind dir not found');
    assert.equal(r.status, 1, 'FAIL 必須 exit 1');

    const files = fs.readdirSync(errorsDir);
    assert.equal(files.length, 1, `errors/ 應有 1 筆 record，實際 ${files.length}：${files.join(',')}`);
    const fname = files[0];
    assert.match(fname, /upgrade_failed_terminal_no_ownmind\.json$/,
      'kind 應為 upgrade_failed_terminal_<原本 FAIL code>');

    const content = JSON.parse(fs.readFileSync(path.join(errorsDir, fname), 'utf8'));
    assert.equal(content.kind, 'upgrade_failed_terminal_no_ownmind');
    assert.match(content.detail, /OwnMind dir not found/);
  });

  it('呼叫 FAIL "verify_local" 同樣寫 record（不依賴 caller 先 call report_error）', () => {
    const r = runMinimalUpgradeWithFail('verify_local', 'local files missing');
    assert.equal(r.status, 1);

    const files = fs.readdirSync(errorsDir);
    assert.ok(files.length >= 1, 'verify_local 也要寫 record');
    const fname = files.find((f) => f.includes('verify_local'));
    assert.ok(fname, 'kind 應含 verify_local');
  });

  it('上一輪「FAIL 前 caller 已 call report_error」案例不會被破壞', () => {
    // 模擬：先 call report_error，再 FAIL → 兩筆都進 errors/（重複觀測可接受、不錯過任何 path）
    const fakeUpgrade = `
      #!/usr/bin/env bash
      set -u
      OWNMIND_DIR="${path.join(tmpHome, '.ownmind')}"
      LOG_FILE="\${OWNMIND_DIR}/logs/upgrade-test.log"
      touch "\${LOG_FILE}"
      . "\${OWNMIND_DIR}/scripts/install-helpers/report-error.sh"

      eval "$(sed -n '/^FAIL()/,/^}/p' "${path.join(repoRoot, 'scripts/interactive-upgrade.sh')}")"

      report_error "upgrade_git_pull_failed" "git pull failed with conflict" "\${LOG_FILE}"
      FAIL "git_pull" "Upgrade aborted"
    `;
    const result = spawnSync('bash', ['-c', fakeUpgrade], {
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);

    const files = fs.readdirSync(errorsDir);
    // 預期：1 筆 caller 寫的 + 1 筆 FAIL 函式 fallback 寫的 = 2 筆
    assert.equal(files.length, 2,
      `應有 2 筆（caller + FAIL fallback），實際 ${files.length}：${files.join(',')}`);

    const kinds = files.map((f) => f.match(/-\d+(?:_[a-zA-Z0-9_]+)?\d*-(.+)\.json$/)?.[1])
      .map((k) => k || '');
    assert.ok(files.some((f) => f.includes('upgrade_git_pull_failed')),
      'caller 寫的 kind 應在');
    assert.ok(files.some((f) => f.includes('upgrade_failed_terminal_git_pull')),
      'FAIL fallback 寫的 kind 應在');
  });
});
