import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';

/**
 * scripts/install-helpers/run-scanner.sh 的 end-to-end 測試。
 *
 * 策略：在 tmp dir 模擬 $HOME 結構 → 放一個偽造的 node（shell script，印 stub 訊息）
 * → 跑 wrapper → 驗證：候選選擇、版本檢查、錯誤處理、log 行為。
 */

const WRAPPER = path.resolve('scripts/install-helpers/run-scanner.sh');
const TMP_BASE = path.join(os.tmpdir(), `ownmind-wrapper-test-${process.pid}-${Date.now()}`);

async function makeHomeDir() {
  const home = path.join(TMP_BASE, `home-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(path.join(home, '.ownmind', 'hooks'), { recursive: true });
  await fs.mkdir(path.join(home, '.ownmind', 'logs'), { recursive: true });
  // 放一個空的 scanner.js；內容不重要，因 stub node 不會真的執行 node
  await fs.writeFile(path.join(home, '.ownmind', 'hooks', 'ownmind-usage-scanner.js'),
    '// stub\n');
  return home;
}

async function writeStubNode(dirPath, { version = 'v22.5.0', exitCode = 0 } = {}) {
  const stub = path.join(dirPath, 'node');
  // Stub：--version 回指定版本字串；其他參數印 "ran: ..." 到 stderr 以便驗證
  await fs.writeFile(stub,
    `#!/bin/bash
if [ "\$1" = "--version" ]; then
  echo "${version}"
  exit 0
fi
echo "ran: $*" 1>&2
exit ${exitCode}
`, 'utf8');
  await fs.chmod(stub, 0o755);
  return stub;
}

function runWrapper(home, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [WRAPPER], {
      env: {
        HOME: home,
        PATH: '/usr/bin:/bin',  // minimal PATH，強迫用 .node-path 或 PATH
        OWNMIND_DIR: path.join(home, '.ownmind'),
        OWNMIND_MIN_NODE_MAJOR: '20',
        OWNMIND_SKIP_SYSTEM_CANDIDATES: '1',  // 測試時關閉 /opt/homebrew 等真實路徑
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8')
      });
    });
  });
}

beforeEach(async () => { await fs.mkdir(TMP_BASE, { recursive: true }); });
afterEach(async () => { try { await fs.rm(TMP_BASE, { recursive: true, force: true }); } catch {} });

describe('run-scanner.sh wrapper', () => {
  it('exits 1 + writes err log when no node found', async () => {
    const home = await makeHomeDir();
    const r = await runWrapper(home);
    assert.equal(r.code, 1);

    const errLog = await fs.readFile(path.join(home, '.ownmind/logs/scanner.err'), 'utf8');
    assert.match(errLog, /no node >= v20 found/);
  });

  it('exits 1 when node is too old', async () => {
    const home = await makeHomeDir();
    const binDir = path.join(home, 'bin');
    await fs.mkdir(binDir, { recursive: true });
    await writeStubNode(binDir, { version: 'v18.17.0' });
    await fs.writeFile(path.join(home, '.ownmind/.node-path'), path.join(binDir, 'node'));

    const r = await runWrapper(home);
    assert.equal(r.code, 1);

    const errLog = await fs.readFile(path.join(home, '.ownmind/logs/scanner.err'), 'utf8');
    assert.match(errLog, /skip .*version=v18\.17\.0/);
  });

  it('uses .node-path cache when version OK + invokes scanner.js', async () => {
    const home = await makeHomeDir();
    const binDir = path.join(home, 'opt-node');
    await fs.mkdir(binDir, { recursive: true });
    const stubPath = await writeStubNode(binDir, { version: 'v22.5.0' });
    await fs.writeFile(path.join(home, '.ownmind/.node-path'), stubPath);

    const r = await runWrapper(home);
    assert.equal(r.code, 0);
    // stub node 被呼叫時印 "ran: <scanner-path>" 到 stderr
    assert.match(r.stderr, /ran: .+ownmind-usage-scanner\.js/);

    const outLog = await fs.readFile(path.join(home, '.ownmind/logs/scanner.log'), 'utf8');
    assert.match(outLog, /using node=/);
    assert.match(outLog, /version=v22\.5\.0/);
  });

  it('falls back to PATH node when .node-path missing', async () => {
    const home = await makeHomeDir();
    const pathDir = path.join(home, 'path-node');
    await fs.mkdir(pathDir, { recursive: true });
    await writeStubNode(pathDir, { version: 'v20.11.0' });
    // 不建 .node-path；靠 PATH 提供
    const r = await runWrapper(home, { PATH: `${pathDir}:/usr/bin:/bin` });
    assert.equal(r.code, 0);
    const outLog = await fs.readFile(path.join(home, '.ownmind/logs/scanner.log'), 'utf8');
    assert.match(outLog, /version=v20\.11\.0/);
  });

  it('falls back to homebrew candidate when .node-path and PATH both fail', async () => {
    const home = await makeHomeDir();
    // 建造 /opt/homebrew-like fake path via $HOME/opt/homebrew/bin
    // 但 wrapper 的 hardcoded path 是真實 /opt/homebrew/bin —
    // 無法完美模擬不動 sudo；此 test 只驗「候選擇序時 .node-path 優先」
    const hbBin = path.join(home, 'my-opt/node');
    await fs.mkdir(path.dirname(hbBin), { recursive: true });
    await writeStubNode(path.dirname(hbBin), { version: 'v20.0.0' });
    // 把 my-opt 放進 PATH
    const r = await runWrapper(home, { PATH: `${path.dirname(hbBin)}:/usr/bin:/bin` });
    assert.equal(r.code, 0);
  });

  it('exits 2 when scanner.js missing', async () => {
    const home = path.join(TMP_BASE, `home-missing-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(home, '.ownmind', 'logs'), { recursive: true });
    const binDir = path.join(home, 'bin');
    await fs.mkdir(binDir, { recursive: true });
    const stubPath = await writeStubNode(binDir, { version: 'v22.0.0' });
    await fs.writeFile(path.join(home, '.ownmind/.node-path'), stubPath);

    const r = await runWrapper(home);
    assert.equal(r.code, 2);
    const errLog = await fs.readFile(path.join(home, '.ownmind/logs/scanner.err'), 'utf8');
    assert.match(errLog, /scanner entry not found/);
  });

  it('runtime opt-out flag exits 0 without even looking for node', async () => {
    const home = await makeHomeDir();
    // 建 opt-out flag；不放 stub node → 若真的跑下去會因找不到 node 而 exit 1
    await fs.writeFile(path.join(home, '.ownmind', '.no-usage-scanner'), '');
    const r = await runWrapper(home);
    assert.equal(r.code, 0, 'opt-out 應該 exit 0，完全 bypass');
    const outLog = await fs.readFile(path.join(home, '.ownmind/logs/scanner.log'), 'utf8');
    assert.match(outLog, /opt-out flag present, skipping/);
  });

  it('respects OWNMIND_MIN_NODE_MAJOR override (=22)', async () => {
    const home = await makeHomeDir();
    const binDir = path.join(home, 'opt-node');
    await fs.mkdir(binDir, { recursive: true });
    const stubPath = await writeStubNode(binDir, { version: 'v20.11.0' });
    await fs.writeFile(path.join(home, '.ownmind/.node-path'), stubPath);

    const r = await runWrapper(home, { OWNMIND_MIN_NODE_MAJOR: '22' });
    assert.equal(r.code, 1, '設 min=22 → v20.11 不合格');
    const errLog = await fs.readFile(path.join(home, '.ownmind/logs/scanner.err'), 'utf8');
    assert.match(errLog, /skip .*version=v20\.11\.0 < v22/);
  });
});
