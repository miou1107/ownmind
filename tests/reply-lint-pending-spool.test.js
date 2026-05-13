import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

/**
 * v1.17.97 — Hook 條件 spool：只在 POST 失敗時寫 reply-lint-pending.jsonl
 *
 * 為什麼：v1.17.96 hook 不論 POST 成功失敗都寫 YYYY-MM-DD.jsonl 當 archive、
 * 但沒有 reader 主動撿走、形同黑洞。v1.17.97 加 SessionStart flush 會撿，
 * 若 hook 也固定寫進同檔、會造成「POST 成功 + 又被 flush 再送一次」DB 重複。
 *
 * 解法（最小改動、不動 archive 行為）：
 *   - 保留 YYYY-MM-DD.jsonl 寫入（archive、debugging 用，沒 reader）
 *   - 新增 reply-lint-pending.jsonl，只在 POST 失敗 / NO_NETWORK 時寫
 *   - SessionStart flush 只看 reply-lint-pending.jsonl、不碰 archive
 */

const repoRoot = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');
const hookPath = path.join(repoRoot, 'hooks', 'ownmind-reply-lint.js');

let tmpHome;
let pendingSpoolPath;
let archiveDir;
let transcriptPath;

function setupTmpHome() {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-pending-spool-test-'));
  fs.mkdirSync(path.join(tmpHome, '.ownmind', 'logs'), { recursive: true });
  archiveDir = path.join(tmpHome, '.ownmind', 'logs');
  pendingSpoolPath = path.join(archiveDir, 'reply-lint-pending.jsonl');
  transcriptPath = path.join(tmpHome, 'transcript.jsonl');
}
function cleanupTmpHome() { fs.rmSync(tmpHome, { recursive: true, force: true }); }

function writeViolatingTranscript() {
  const turn = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'I really should refactor everything completely from scratch immediately because clearly bugs.' }] },
  });
  fs.writeFileSync(transcriptPath, turn + '\n');
}

function setupCredentials(apiUrl) {
  const claudeDir = path.join(tmpHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
    mcpServers: { ownmind: { env: { OWNMIND_API_KEY: 'k', OWNMIND_API_URL: apiUrl } } },
  }));
}

function runHook(env = {}) {
  return spawnSync('node', [hookPath], {
    input: JSON.stringify({
      session_id: 'x',
      transcript_path: transcriptPath,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      OWNMIND_TTY_FORCE_FALLBACK: '1',
      ...env,
    },
  });
}

/**
 * 異步版 spawn — fake server 跟 hook 同 Node process 時必須用這個，
 * 否則 spawnSync 卡住 event loop、server 接不到連線、hook 看到 connection refused。
 */
function runHookAsync(env = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', [hookPath], {
      env: {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        OWNMIND_TTY_FORCE_FALLBACK: '1',
        ...env,
      },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', code => resolve({ status: code, stdout, stderr }));
    child.stdin.write(JSON.stringify({
      session_id: 'x',
      transcript_path: transcriptPath,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    }));
    child.stdin.end();
  });
}

describe('v1.17.97 — Hook 條件 spool（pending 檔只在失敗時寫）', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('POST 成功 → reply-lint-pending.jsonl 不該被建立', async () => {
    const server = await new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        let body = ''; req.on('data', c => body += c);
        req.on('end', () => { res.statusCode = 200; res.end('{"inserted":1}'); });
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      writeViolatingTranscript();
      const apiUrl = `http://127.0.0.1:${server.address().port}`;
      setupCredentials(apiUrl);
      // 必須用 async spawn — fake server 跟 hook 同 process、spawnSync 會卡住 event loop
      const r = await runHookAsync({ OWNMIND_REPLY_LINT_API_URL: apiUrl });
      assert.equal(r.status, 0);
      assert.equal(r.stderr, '');
      assert.equal(fs.existsSync(pendingSpoolPath), false,
        'POST 成功時不該寫 reply-lint-pending.jsonl（避免 SessionStart flush 重複送）');
    } finally { server.close(); }
  });

  it('POST 失敗（伺服器不在）→ reply-lint-pending.jsonl 該被寫入', () => {
    writeViolatingTranscript();
    // 指向一個未啟動的 port — POST 一定失敗
    setupCredentials('http://127.0.0.1:1');  // port 1 reserved, 不會有 server
    const r = runHook({ OWNMIND_REPLY_LINT_API_URL: 'http://127.0.0.1:1' });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    assert.ok(fs.existsSync(pendingSpoolPath),
      'POST 失敗時必須 spool 到 pending 檔等下次 SessionStart flush');
    const lines = fs.readFileSync(pendingSpoolPath, 'utf8').trim().split('\n');
    assert.ok(lines.length > 0);
    const ev = JSON.parse(lines[0]);
    assert.equal(ev.event, 'iron_rule_compliance');
    assert.equal(ev.details.action, 'violate');
    assert.match(ev.details.rule_code, /^IR-/);
  });

  it('NO_NETWORK 模式 → reply-lint-pending.jsonl 該被寫入（離線 / 測試 / opt-out）', () => {
    writeViolatingTranscript();
    setupCredentials('http://127.0.0.1:1');
    const r = runHook({ OWNMIND_REPLY_LINT_NO_NETWORK: '1' });
    assert.equal(r.status, 0);
    assert.ok(fs.existsSync(pendingSpoolPath),
      'NO_NETWORK 模式（離線 / 測試）也該 spool — 等網路恢復下次 flush');
  });

  it('沒違反 → 不寫 archive 也不寫 pending', () => {
    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '好、用全中文回應、沒違反。' }] },
    }) + '\n');
    setupCredentials('http://127.0.0.1:1');
    const r = runHook({ OWNMIND_REPLY_LINT_NO_NETWORK: '1' });
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(pendingSpoolPath), false,
      '沒違反 → 不該動 pending 檔');
  });

  // review-N1：1MB size cap + rotate
  it('pending 檔超過 1MB → rotate 成 .old、新 spool 從乾淨檔開始', () => {
    // 寫一個 > 1MB 的 pending 檔
    const padding = 'x'.repeat(1100 * 1024);
    fs.writeFileSync(pendingSpoolPath, padding);
    const oldStat = fs.statSync(pendingSpoolPath);
    assert.ok(oldStat.size > 1024 * 1024);

    writeViolatingTranscript();
    setupCredentials('http://127.0.0.1:1');
    runHook({ OWNMIND_REPLY_LINT_NO_NETWORK: '1' });

    // .old 檔該存在（rotate 過去）
    assert.ok(fs.existsSync(pendingSpoolPath + '.old'),
      '> 1MB 的舊 pending 該被 rotate 成 .old');
    // 新 pending 該只有這次新加的那筆（< 5KB）
    const newStat = fs.statSync(pendingSpoolPath);
    assert.ok(newStat.size < 10 * 1024,
      `rotate 後新 pending 應只含這次新事件、實際 ${newStat.size} bytes`);
  });

  it('既有 pending 內容 + 新一輪失敗 → append 不覆蓋', () => {
    fs.writeFileSync(pendingSpoolPath, JSON.stringify({
      ts: '2026-05-12T00:00:00.000Z',
      event: 'iron_rule_compliance',
      tool: 'claude-code',
      source: 'reply-lint-hook',
      details: { action: 'violate', rule_code: 'IR-037', message: 'old' },
    }) + '\n');
    writeViolatingTranscript();
    setupCredentials('http://127.0.0.1:1');
    runHook({ OWNMIND_REPLY_LINT_NO_NETWORK: '1' });
    const lines = fs.readFileSync(pendingSpoolPath, 'utf8').trim().split('\n');
    assert.ok(lines.length >= 2, '既有 + 新加 — append 模式');
    assert.equal(JSON.parse(lines[0]).details.message, 'old');
  });
});
