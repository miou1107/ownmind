import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * v1.17.96 — hooks/ownmind-reply-lint.js（Stop hook 整合 IR-037 + IR-036）
 *
 * 為什麼存在：
 *   v1.17.95 把 IR-037（中英混雜）+ IR-036（行話沒附白話說明）的判斷邏輯
 *   寫成 shared/language-lint.js 純函式 lib，但沒整合到任何卡關點 — AI 還是
 *   靠自覺、IR-027「提醒無效，邏輯才有效」沒落地。
 *
 *   v1.17.96 寫 Stop hook：每輪 AI 回話結束時自動讀 transcript、抽最後一輪
 *   assistant text、跑 lintReply、違反就寫 banner 到 user terminal +
 *   POST /api/activity/batch 報 violate。
 *
 * Vin 三條規格（沿用 v1.17.71 ownmind-tty-echo.cjs）：
 *   1. user 必須看見（不能只寫 stderr / additionalContext）
 *   2. 同次違反合併成單一招牌區塊
 *   3. 嚴禁被 AI 過濾 / 吃掉 — fallback 寫 ~/.ownmind/logs/banner-pending.jsonl
 *
 * Stop hook payload 規格（Claude Code 官方）：
 *   { session_id, transcript_path, hook_event_name: 'Stop', stop_hook_active }
 *   stop_hook_active=true 代表這次 Stop 是因為前一個 hook block 觸發的、要立刻退出避免迴圈。
 */

const repoRoot = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');
const hookPath = path.join(repoRoot, 'hooks', 'ownmind-reply-lint.js');

let tmpHome;
let pendingFile;
let transcriptPath;

function runHook(input, env = {}) {
  return spawnSync('node', [hookPath], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      // 強制 fallback 路徑（測試環境沒 controlling tty）
      OWNMIND_TTY_FORCE_FALLBACK: '1',
      // 禁止真的打 API（測試端不該打網路）
      OWNMIND_REPLY_LINT_NO_NETWORK: '1',
      ...env,
    },
  });
}

function setupTmpHome() {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-reply-lint-test-'));
  fs.mkdirSync(path.join(tmpHome, '.ownmind', 'logs'), { recursive: true });
  pendingFile = path.join(tmpHome, '.ownmind', 'logs', 'banner-pending.jsonl');
  transcriptPath = path.join(tmpHome, 'transcript.jsonl');
}

function cleanupTmpHome() {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

/**
 * 寫一個假的 Claude Code transcript JSONL：每行是 {type, message:{content:[...]}}。
 * @param {Array<{role: 'user'|'assistant', text?: string, parts?: Array}>} turns
 */
function writeTranscript(turns) {
  const lines = turns.map(t => {
    if (t.role === 'user') {
      return JSON.stringify({
        type: 'user',
        message: { role: 'user', content: t.text || '' },
      });
    }
    // assistant
    const content = t.parts || [{ type: 'text', text: t.text || '' }];
    return JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content },
    });
  });
  fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');
}

function stopPayload(extra = {}) {
  return {
    session_id: 'test-session-001',
    transcript_path: transcriptPath,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    ...extra,
  };
}

describe('v1.17.96 — ownmind-reply-lint.js: 基本契約', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('hook 檔案存在 + 可被 node spawn', () => {
    assert.ok(fs.existsSync(hookPath), 'hooks/ownmind-reply-lint.js 必須存在');
    const r = runHook('{}');
    assert.equal(r.status, 0, '空輸入也要 exit 0、絕不 crash');
  });

  it('exit code 永遠是 0（不擋 AI 流程）', () => {
    writeTranscript([
      { role: 'user', text: '你好' },
      { role: 'assistant', text: 'I think we should refactor the entire codebase using a completely different approach.' },
    ]);
    const r = runHook(stopPayload());
    assert.equal(r.status, 0, '即使違反也要 exit 0、只警告不擋');
  });

  it('stderr / stdout 永遠空白（不能被 AI 看到）', () => {
    writeTranscript([
      { role: 'assistant', text: 'I think we should refactor using a different approach completely.' },
    ]);
    const r = runHook(stopPayload());
    assert.equal(r.stderr, '', 'stderr 必須空白（IR-027 規格 #3）');
    assert.ok(!r.stdout.includes('【OwnMind'), 'stdout 不能含 banner（會被 AI 通道吃）');
  });

  it('壞掉的 stdin JSON 不 crash', () => {
    const r = runHook('this is not json at all');
    assert.equal(r.status, 0);
  });

  it('transcript_path 指向不存在檔案 → exit 0、不寫 banner', () => {
    const payload = {
      session_id: 'x',
      transcript_path: path.join(tmpHome, 'does-not-exist.jsonl'),
      hook_event_name: 'Stop',
      stop_hook_active: false,
    };
    const r = runHook(payload);
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(pendingFile), false, '找不到 transcript 不該寫 banner');
  });
});

describe('v1.17.96 — IR-037 / IR-036 違反偵測（從 transcript 抽最後一輪 assistant）', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('全中文回話 → 不寫 banner（沒違反）', () => {
    writeTranscript([
      { role: 'user', text: '你好' },
      { role: 'assistant', text: '好、那我來修這個問題、先寫測試再實作。' },
    ]);
    const r = runHook(stopPayload());
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(pendingFile), false, '沒違反不該動 pending file');
  });

  it('中英混雜超過 15% → 寫 IR-037 違反 banner', () => {
    writeTranscript([
      { role: 'assistant', text: 'I think we should refactor the codebase using a completely different approach because the implementation has obvious bugs.' },
    ]);
    const r = runHook(stopPayload());
    assert.equal(r.status, 0);
    assert.ok(fs.existsSync(pendingFile), '違反該寫 fallback banner');
    const content = fs.readFileSync(pendingFile, 'utf8');
    assert.match(content, /IR-037/, 'banner 必須含 IR-037 標識');
  });

  it('只看最後一輪 assistant — 中間違反、最後乾淨 → 不寫 banner', () => {
    writeTranscript([
      { role: 'user', text: 'q1' },
      { role: 'assistant', text: 'I will refactor everything completely using a different approach now.' },
      { role: 'user', text: 'q2' },
      { role: 'assistant', text: '好、改完了、用全中文回。' },
    ]);
    const r = runHook(stopPayload());
    assert.equal(fs.existsSync(pendingFile), false,
      '只看最後一輪 — 之前的違反不算（會由前面的 Stop hook 處理過）');
  });

  it('最後一輪 assistant 含 tool_use parts → 只抽 text parts 跑 lint', () => {
    writeTranscript([
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: '好的、我來看一下。' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/x' }, id: 'toolu_1' },
          { type: 'text', text: '看完了。' },
        ],
      },
    ]);
    const r = runHook(stopPayload());
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(pendingFile), false,
      '純中文 text parts 不該違反 — tool_use 不參與 lint');
  });

  it('banner 招牌格式：含【OwnMind v?】+ 違反條目', () => {
    writeTranscript([
      { role: 'assistant', text: 'I really think we should refactor everything immediately because the codebase is broken.' },
    ]);
    runHook(stopPayload());
    assert.ok(fs.existsSync(pendingFile));
    const record = JSON.parse(fs.readFileSync(pendingFile, 'utf8').trim().split('\n').pop());
    const block = record.block;
    assert.match(block, /^【OwnMind\s+v[\d.?]+】/, 'banner 必須以招牌開頭');
    assert.match(block, /回話品質/, 'banner 必須標示這是回話品質檢查');
  });
});

describe('v1.17.96 — stop_hook_active 防迴圈', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('stop_hook_active=true → 不跑 lint、不寫 banner（避免遞迴）', () => {
    writeTranscript([
      { role: 'assistant', text: 'I think we should refactor the entire codebase using a different approach.' },
    ]);
    const r = runHook(stopPayload({ stop_hook_active: true }));
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(pendingFile), false,
      'stop_hook_active=true 必須立刻退出、不寫 banner');
  });
});

describe('v1.17.96 — fallback banner 不污染 stdout/stderr', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('違反時 — stdout/stderr 仍空白、所有訊息只到 fallback file', () => {
    writeTranscript([
      { role: 'assistant', text: 'I really should refactor this whole thing completely from scratch immediately.' },
    ]);
    const r = runHook(stopPayload());
    assert.equal(r.stderr, '');
    assert.ok(!r.stdout.includes('IR-037'), 'IR-037 訊息不該外漏到 stdout');
    assert.ok(!r.stdout.includes('【OwnMind'), 'OwnMind banner 不該外漏到 stdout');
  });

  // review-B3：嚴格驗 stdout / stderr 完全空白（不只是不含 banner）
  it('嚴格契約：違反 + 沒違反 / 空 input / 壞 input — stdout 與 stderr 都必須完全空白', () => {
    writeTranscript([
      { role: 'assistant', text: 'I really should refactor everything completely from scratch immediately because of bugs.' },
    ]);
    const cases = [
      { name: '違反', input: stopPayload() },
      { name: '空 input', input: '{}' },
      { name: '壞 JSON', input: 'this is not json' },
      { name: 'transcript 不存在', input: stopPayload({ transcript_path: path.join(tmpHome, 'no-such-file.jsonl') }) },
      { name: 'stop_hook_active=true', input: stopPayload({ stop_hook_active: true }) },
    ];
    for (const c of cases) {
      const r = runHook(c.input);
      assert.equal(r.stdout, '', `[${c.name}] stdout 必須完全空白、實際：${JSON.stringify(r.stdout)}`);
      assert.equal(r.stderr, '', `[${c.name}] stderr 必須完全空白、實際：${JSON.stringify(r.stderr)}`);
      assert.equal(r.status, 0, `[${c.name}] 必須 exit 0`);
    }
  });
});

// review-B1：transcript_path 安全性檢查
describe('v1.17.96 — transcript_path 防呆 / 安全', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('非 .jsonl 副檔名 → 拒絕讀取', () => {
    const txtPath = path.join(tmpHome, 'fake.txt');
    fs.writeFileSync(txtPath, '{"type":"assistant","message":{"content":[{"type":"text","text":"refactor everything completely"}]}}');
    const r = runHook(stopPayload({ transcript_path: txtPath }));
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(pendingFile), false, '非 .jsonl 不該被 lint');
  });

  it('空檔案 → 拒絕讀取', () => {
    const empty = path.join(tmpHome, 'empty.jsonl');
    fs.writeFileSync(empty, '');
    const r = runHook(stopPayload({ transcript_path: empty }));
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(pendingFile), false);
  });

  it('目錄而非檔案 → 拒絕讀取', () => {
    const dir = path.join(tmpHome, 'a-dir.jsonl');
    fs.mkdirSync(dir);
    const r = runHook(stopPayload({ transcript_path: dir }));
    assert.equal(r.status, 0);
  });
});

// review-B4：tail 截斷防呆
describe('v1.17.96 — 大 transcript 尾巴讀取 — 第一行可能截斷', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('檔案 > 256KB 時、第一行被切到中間 → 不該嘗試 parse 那行', () => {
    // 寫一個 > 256KB 的 transcript：
    //   - 開頭塞一個極大的 valid assistant entry（超過 256KB）
    //   - 末尾塞一個小的 valid assistant entry
    // tail 讀進來時第一行一定是中間切起來的、不是合法 JSON
    const padding = 'x'.repeat(300 * 1024);  // > 256KB
    const huge = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: padding }] },
    });
    const lastTurn = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '好、用全中文回最後一輪、不該被視為違反。' }] },
    });
    fs.writeFileSync(transcriptPath, huge + '\n' + lastTurn + '\n');
    const r = runHook(stopPayload());
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(pendingFile), false,
      '最後一輪是純中文、不該寫 banner（驗證 hook 沒被截斷的第一行卡住而誤判）');
  });
});

// review-B3：Compliance event POST schema 驗證（fake server）
describe('v1.17.96 — POST /api/activity/batch schema 對齊 server 期望', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  function startFakeServer(handler) {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          try { handler({ method: req.method, url: req.url, body, headers: req.headers }); }
          catch { /* ignore */ }
          res.statusCode = 200;
          res.end('{"inserted":1}');
        });
      });
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  function setupCredentials(apiUrl) {
    const claudeDir = path.join(tmpHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
      mcpServers: { ownmind: { env: { OWNMIND_API_KEY: 'test-key', OWNMIND_API_URL: apiUrl } } },
    }));
  }

  it('違反時 POST 的 body 對齊 src/routes/activity.js batch handler 規格', async () => {
    const captured = [];
    const server = await startFakeServer((req) => captured.push(req));
    try {
      const port = server.address().port;
      const apiUrl = `http://127.0.0.1:${port}`;
      setupCredentials(apiUrl);
      writeTranscript([
        { role: 'assistant', text: 'I should refactor everything completely from scratch immediately because clearly bugs.' },
      ]);
      // 注意這個 case 不設 NO_NETWORK、要讓 POST 真的打出去
      const r = await new Promise((resolve) => {
        const child = require('node:child_process').spawn('node', [hookPath], {
          env: {
            ...process.env,
            HOME: tmpHome,
            USERPROFILE: tmpHome,
            OWNMIND_TTY_FORCE_FALLBACK: '1',
            OWNMIND_REPLY_LINT_API_URL: apiUrl,
          },
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', c => { stdout += c; });
        child.stderr.on('data', c => { stderr += c; });
        child.on('close', (code) => resolve({ status: code, stdout, stderr }));
        child.stdin.write(JSON.stringify(stopPayload()));
        child.stdin.end();
      });

      assert.equal(r.status, 0);
      assert.equal(r.stderr, '');
      assert.equal(captured.length, 1, '應該打出 1 個 POST');
      assert.equal(captured[0].method, 'POST');
      assert.equal(captured[0].url, '/api/activity/batch');
      assert.match(captured[0].headers['authorization'], /^Bearer test-key$/);

      const parsed = JSON.parse(captured[0].body);
      assert.ok(Array.isArray(parsed.events), 'body 必須有 events array');
      assert.ok(parsed.events.length > 0);
      const ev = parsed.events[0];
      // server src/routes/activity.js:145 — 缺 ts 或 event 會直接 continue 跳過
      assert.ok(ev.ts, 'event.ts 必填（否則 server 會跳過 / 不落 DB）');
      assert.equal(ev.event, 'iron_rule_compliance', 'event.event 必為 iron_rule_compliance');
      assert.equal(ev.tool, 'claude-code');
      assert.equal(ev.source, 'reply-lint-hook');
      assert.ok(ev.details && typeof ev.details === 'object');
      assert.equal(ev.details.action, 'violate');
      assert.match(ev.details.rule_code, /^IR-/);
    } finally {
      server.close();
    }
  });
});

// 必要：require 給上面 fake server 用（ESM module 內混用）
import { createRequire } from 'node:module';
import http from 'node:http';
const require = createRequire(import.meta.url);
