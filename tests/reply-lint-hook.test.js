import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * v1.17.96 — hooks/ownmind-reply-lint.js (Stop hook integration for IR-037 + IR-036)
 *
 * Why it exists:
 *   v1.17.95 turned the IR-037 (mixed Chinese/English) + IR-036 (jargon without a
 *   plain-language gloss) detection logic into a pure-function library at
 *   shared/language-lint.js, but did not wire it into any gating point — AI was
 *   still on its honor system, and IR-027 "reminders don't work, logic does" had
 *   not landed.
 *
 *   v1.17.96 writes a Stop hook: at the end of each AI reply, automatically read
 *   the transcript, pull the last assistant turn, run lintReply, and on violation
 *   write a banner to the user's terminal + POST /api/activity/batch with violate.
 *
 * Vin's three specs (inherited from v1.17.71 ownmind-tty-echo.cjs):
 *   1. The user must see it (cannot use stderr / additionalContext only).
 *   2. Multiple violations in one turn merge into a single signature block.
 *   3. The AI must not be able to filter / swallow them — fallback writes
 *      ~/.ownmind/logs/banner-pending.jsonl.
 *
 * Stop hook payload spec (official Claude Code):
 *   { session_id, transcript_path, hook_event_name: 'Stop', stop_hook_active }
 *   stop_hook_active=true means this Stop fired because the previous hook blocked;
 *   exit immediately to avoid an infinite loop.
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

      // Block real API calls (tests must not hit the network).
      OWNMIND_REPLY_LINT_NO_NETWORK: '1',
      ...env,
    },
  });
}

function setupTmpHome() {
  tmpHome = tempDir('ownmind-reply-lint-test-');
  fs.mkdirSync(path.join(tmpHome, '.ownmind', 'logs'), { recursive: true });
  pendingFile = path.join(tmpHome, '.ownmind', 'logs', 'banner-pending.jsonl');
  transcriptPath = path.join(tmpHome, 'transcript.jsonl');

  // v1.26.171: a machine with no credentials or no enforcement bundle now SAYS SO on every
  // turn — that loudness is the feature, but it is not what this file tests. Stage a
  // configured, quiet machine (credentials + a bundle whose one selector matches nothing)
  // so these tests exercise the lint validators alone.
  fs.writeFileSync(path.join(tmpHome, '.claude.json'), JSON.stringify({
    mcpServers: {
      ownmind: { env: { OWNMIND_API_KEY: 'test-key', OWNMIND_API_URL: 'http://127.0.0.1:1/unreachable' } },
    },
  }));
  fs.mkdirSync(path.join(tmpHome, '.ownmind', 'cache'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpHome, '.ownmind', 'cache', 'enforcement.json'),
    JSON.stringify({ selectors: [{ id: 1, keywords: ['zzz-matches-nothing'], tags: [] }], guards: [], injectables: [] }),
  );

  // v1.21.0: rule-driven architecture requires user-iron-rule cache to declare which
  // validators to enable. Tests always write a fake cache enabling all 3 validators
  // (simulating the "user opted in to all" scenario).
  const cacheDir = path.join(tmpHome, '.ownmind', 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const cachePath = path.join(cacheDir, 'iron_rules.json');
  fs.writeFileSync(cachePath, JSON.stringify([
    {
      code: 'TEST-JARGON',
      metadata: { lint_validator: { name: 'jargon_explanation', params: {} } },
    },
    {
      code: 'TEST-MIXED',
      metadata: { lint_validator: { name: 'language_mixed_ratio', params: { threshold: 0.15 } } },
    },
    {
      code: 'TEST-PRIVACY',
      metadata: { lint_validator: { name: 'privacy_detect', params: {} } },
    },
  ]));
}

function cleanupTmpHome() {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

/**
 * Write a fake Claude Code transcript JSONL: each line is {type, message:{content:[...]}}.
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

describe('v1.17.96 — ownmind-reply-lint.js: basic contract', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('hook file exists + can be spawned with node', () => {
    assert.ok(fs.existsSync(hookPath), 'hooks/ownmind-reply-lint.js must exist');
    const r = runHook('{}');
    assert.equal(r.status, 0, 'empty input must exit 0; never crash');
  });

  it('exit code is always 0 (does not block AI flow)', () => {
    writeTranscript([
      { role: 'user', text: '你好' },
      { role: 'assistant', text: 'I think we should refactor the entire codebase using a completely different approach.' },
    ]);
    const r = runHook(stopPayload());
    assert.equal(r.status, 0, 'even on violation, exit 0; warn-only, never block');
  });

  it('stderr blank; stdout carries only the systemMessage JSON (never model-visible text)', () => {
    // v1.26.171: the banner rides `{"systemMessage": …}` on stdout — the channel Claude Code
    // renders to the HUMAN and never feeds to the model. Raw banner text outside that JSON
    // would be the old bug back.
    writeTranscript([
      { role: 'assistant', text: 'I think we should refactor using a different approach completely.' },
    ]);
    const r = runHook(stopPayload());
    assert.equal(r.stderr, '', 'stderr must stay blank on the warn path');
    const parsed = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(parsed), ['systemMessage'], 'stdout is exactly one systemMessage object');
    assert.match(parsed.systemMessage, /Reply quality lint/);
  });

  it('malformed stdin JSON does not crash', () => {
    const r = runHook('this is not json at all');
    assert.equal(r.status, 0);
  });

  it('transcript_path pointing to a missing file → exit 0, no banner', () => {
    const payload = {
      session_id: 'x',
      transcript_path: path.join(tmpHome, 'does-not-exist.jsonl'),
      hook_event_name: 'Stop',
      stop_hook_active: false,
    };
    const r = runHook(payload);
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(pendingFile), false, 'missing transcript should not write a banner');
  });
});

describe('v1.17.96 — IR-037 / IR-036 violation detection (extracts the last assistant turn from transcript)', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('all-Chinese reply → no banner (no violation)', () => {
    writeTranscript([
      { role: 'user', text: '你好' },
      { role: 'assistant', text: '好、那我來修這個問題、先寫測試再實作。' },
    ]);
    const r = runHook(stopPayload());
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(pendingFile), false, 'no violation should not touch the pending file');
  });

  it('Chinese/English mix above 15% → writes a lint_language_mixed_ratio violation banner', () => {
    writeTranscript([
      { role: 'assistant', text: 'I think we should refactor the codebase using a completely different approach because the implementation has obvious bugs.' },
    ]);
    const r = runHook(stopPayload());
    assert.equal(r.status, 0);
    assert.ok(fs.existsSync(pendingFile), 'violation should write a fallback banner');
    const content = fs.readFileSync(pendingFile, 'utf8');
    // v1.20.4: banner uses a neutral event constant, no longer hardcoding IR-037.
    assert.match(content, /lint_language_mixed_ratio/, 'banner must include the neutral event constant identifier');
    // Also verify no IR-037 string leaks (neutralization guarantee).
    assert.ok(!content.includes('IR-037'), 'banner must not contain IR-037 (v1.20.4 neutralization)');
  });

  it('only the last assistant turn matters — violation mid-conversation, clean at the end → no banner', () => {
    writeTranscript([
      { role: 'user', text: 'q1' },
      { role: 'assistant', text: 'I will refactor everything completely using a different approach now.' },
      { role: 'user', text: 'q2' },
      { role: 'assistant', text: '好、改完了、用全中文回。' },
    ]);
    const r = runHook(stopPayload());
    assert.equal(fs.existsSync(pendingFile), false,
      'only the last turn is checked — prior violations are not counted (the earlier Stop hook handled them)');
  });

  it('last assistant turn contains tool_use parts → lint only runs on text parts', () => {
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
      'pure-Chinese text parts should not violate — tool_use does not participate in lint');
  });

  it('banner signature format: contains [OwnMind v?] + violation entries', () => {
    writeTranscript([
      { role: 'assistant', text: 'I really think we should refactor everything immediately because the codebase is broken.' },
    ]);
    runHook(stopPayload());
    assert.ok(fs.existsSync(pendingFile));
    const record = JSON.parse(fs.readFileSync(pendingFile, 'utf8').trim().split('\n').pop());
    const block = record.block;
    assert.match(block, /^\[OwnMind\s+v[\d.?]+\]/, 'banner must begin with the signature');
    assert.match(block, /Reply quality lint/, 'banner must mark this as the reply-quality check');
  });
});

describe('v1.17.96 — stop_hook_active loop guard', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('stop_hook_active=true → skip lint, no banner (avoid recursion)', () => {
    writeTranscript([
      { role: 'assistant', text: 'I think we should refactor the entire codebase using a different approach.' },
    ]);
    const r = runHook(stopPayload({ stop_hook_active: true }));
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(pendingFile), false,
      'stop_hook_active=true must exit immediately and not write a banner');
  });
});

describe('v1.17.96 — fallback banner does not pollute stdout/stderr', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('on violation — stderr blank; the banner travels inside systemMessage, and also to the fallback file', () => {
    writeTranscript([
      { role: 'assistant', text: 'I really should refactor this whole thing completely from scratch immediately.' },
    ]);
    const r = runHook(stopPayload());
    assert.equal(r.stderr, '');
    const parsed = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(parsed), ['systemMessage'],
      'nothing may share stdout with the systemMessage object - Claude Code parses it whole');
    assert.ok(fs.existsSync(pendingFile), 'the audit spool still records what was said');
  });

  // review-B3, revised for v1.26.171: every path that says nothing must say NOTHING (an empty
  // systemMessage would render a blank line under every reply), and the one path that speaks
  // must speak only valid JSON.
  it('strict contract: quiet paths are byte-for-byte silent; the violation path is exactly one JSON object', () => {
    writeTranscript([
      { role: 'assistant', text: 'I really should refactor everything completely from scratch immediately because of bugs.' },
    ]);
    const quietCases = [
      { name: 'empty input', input: '{}' },
      { name: 'malformed JSON', input: 'this is not json' },
      { name: 'transcript missing', input: stopPayload({ transcript_path: path.join(tmpHome, 'no-such-file.jsonl') }) },
      { name: 'stop_hook_active=true', input: stopPayload({ stop_hook_active: true }) },
    ];
    for (const c of quietCases) {
      const r = runHook(c.input);
      assert.equal(r.stdout, '', `[${c.name}] stdout must be completely blank, actual: ${JSON.stringify(r.stdout)}`);
      assert.equal(r.stderr, '', `[${c.name}] stderr must be completely blank, actual: ${JSON.stringify(r.stderr)}`);
      assert.equal(r.status, 0, `[${c.name}] must exit 0`);
    }
    const r = runHook(stopPayload());
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    assert.deepEqual(Object.keys(JSON.parse(r.stdout)), ['systemMessage']);
  });
});

// review-B1: transcript_path safety checks
describe('v1.17.96 — transcript_path defense / safety', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('non-.jsonl extension → refuse to read', () => {
    const txtPath = path.join(tmpHome, 'fake.txt');
    fs.writeFileSync(txtPath, '{"type":"assistant","message":{"content":[{"type":"text","text":"refactor everything completely"}]}}');
    const r = runHook(stopPayload({ transcript_path: txtPath }));
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(pendingFile), false, 'non-.jsonl must not be linted');
  });

  it('empty file → refuse to read', () => {
    const empty = path.join(tmpHome, 'empty.jsonl');
    fs.writeFileSync(empty, '');
    const r = runHook(stopPayload({ transcript_path: empty }));
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(pendingFile), false);
  });

  it('directory instead of a file → refuse to read', () => {
    const dir = path.join(tmpHome, 'a-dir.jsonl');
    fs.mkdirSync(dir);
    const r = runHook(stopPayload({ transcript_path: dir }));
    assert.equal(r.status, 0);
  });
});

// review-B4: tail-truncation defense
describe('v1.17.96 — large transcript tail read — first line may be truncated', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('file > 256KB, first line cut mid-stream → must not attempt to parse that line', () => {
    // Write a > 256KB transcript:
    //   - prepend a huge valid assistant entry (> 256KB)
    //   - append a small valid assistant entry at the tail
    // When the tail is read, the first line will be cut in the middle and is not valid JSON.
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
      'last turn is all Chinese — no banner (verifies the hook is not stalled on the truncated first line)');
  });
});

// review-B3: validate compliance event POST schema (fake server)
describe('v1.17.96 — POST /api/activity/batch schema aligns with server expectations', () => {
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

  it('on violation, POST body aligns with the src/routes/activity.js batch handler spec', async () => {
    const captured = [];
    const server = await startFakeServer((req) => captured.push(req));
    try {
      const port = server.address().port;
      const apiUrl = `http://127.0.0.1:${port}`;
      setupCredentials(apiUrl);
      writeTranscript([
        { role: 'assistant', text: 'I should refactor everything completely from scratch immediately because clearly bugs.' },
      ]);
      // Important: do not set NO_NETWORK here — let the POST actually go out.
      const r = await new Promise((resolve) => {
        const child = require('node:child_process').spawn('node', [hookPath], {
          env: {
            ...process.env,
            HOME: tmpHome,
            USERPROFILE: tmpHome,
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
      assert.equal(captured.length, 1, 'should fire exactly one POST');
      assert.equal(captured[0].method, 'POST');
      assert.equal(captured[0].url, '/api/activity/batch');
      assert.match(captured[0].headers['authorization'], /^Bearer test-key$/);

      const parsed = JSON.parse(captured[0].body);
      assert.ok(Array.isArray(parsed.events), 'body must contain an events array');
      assert.ok(parsed.events.length > 0);
      const ev = parsed.events[0];
      // server src/routes/activity.js:145 — missing ts or event causes continue/skip
      assert.ok(ev.ts, 'event.ts is required (server skips events lacking it / never writes DB)');
      assert.equal(ev.event, 'iron_rule_compliance', 'event.event must be iron_rule_compliance');
      assert.equal(ev.tool, 'claude-code');
      assert.equal(ev.source, 'reply-lint-hook');
      assert.ok(ev.details && typeof ev.details === 'object');
      assert.equal(ev.details.action, 'violate');
      // v1.20.4: rule_code may be empty (no matching rule in the cache) or a user iron-rule code;
      // at minimum, triggered_by_event must be present.
      assert.ok(
        typeof ev.details.rule_code === 'string',
        'rule_code must be a string (even if empty, the field must exist)'
      );
      assert.match(
        ev.details.triggered_by_event,
        /^(lint_|privacy_check)/,
        'triggered_by_event must be a neutral event constant'
      );
    } finally {
      server.close();
    }
  });
});

// Required: require for the fake server above (mixed use inside an ESM module)
import { createRequire } from 'node:module';
import http from 'node:http';
import { tempDir } from './helpers/temp-dir.js';
const require = createRequire(import.meta.url);
