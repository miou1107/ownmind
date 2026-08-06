// v1.26.83 — the Node SessionStart hook loads memories and tells nobody.
//
// Found live, during the verification of v1.26.82. Adam restarted Claude Code; the server
// showed MCP activity from his new session and no hook-sourced `init` — the exact number
// the whole Windows repair was to be judged by. The reason is not that his hook failed:
// the Node hook's logEvent() only appends to the local JSONL. The bash hook it replaced
// also POSTs each event to /api/activity/batch. That one line was lost in translation.
//
// Two consequences, the second worse than the first:
//   - a working Windows hook is indistinguishable, server-side, from a dead one
//   - the v1.26.81 `memory_load` check reads hook-sourced inits from activity_logs, so it
//     reports every healthy Windows machine as "memories have never loaded", forever.
//     A check that cries wolf on healthy machines teaches everyone to ignore it.
//
// The behavioural test runs the real hook binary against a local fake server and asserts
// on what actually arrives — both sides real, per IR-128.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(repoRoot, 'hooks', 'ownmind-session-start.js');

describe('node SessionStart hook — a successful load reaches the server', () => {
  let server;
  let baseUrl;
  const received = { batch: [], init: 0 };

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.url.startsWith('/api/memory/init')) {
          received.init += 1;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            server_version: '9.9.9-test',
            profile: null, principles: [], iron_rules_digest: '', memories: [],
          }));
          return;
        }
        if (req.url.startsWith('/api/activity/batch')) {
          try { received.batch.push(...(JSON.parse(body).events || [])); } catch {}
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ inserted: 1, deduped: 0, failed: 0 }));
          return;
        }
        // Broadcasts, bug notifications, anything else the hook asks for: empty success.
        res.setHeader('content-type', 'application/json');
        res.end(req.url.includes('broadcast') ? '[]' : '{}');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server?.close());

  it('POSTs a hook-sourced init to /api/activity/batch', async () => {
    // A scratch HOME so the run cannot touch this machine's real logs or read its real
    // credentials. The key and url are supplied the way Adam's machine supplies them:
    // through the environment, which the hook reads via the shared resolver.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-hook-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });

    await new Promise((resolve, reject) => {
      execFile('node', [HOOK], {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          OWNMIND_API_KEY: 'test-key-0123456789abcdef',
          OWNMIND_API_URL: baseUrl,
        },
        timeout: 20000,
      }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)));
    });

    assert.ok(received.init >= 1, 'the hook never even called the init endpoint');

    // Give the fire-and-forget upload a moment; the hook must not block its exit on it,
    // so the process can finish slightly ahead of the request landing.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !received.batch.some((e) => e.event === 'init' && e.status === 'ok')) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const init = received.batch.find((e) => e.event === 'init' && e.status === 'ok');
    assert.ok(init, `no init event reached the server; got: ${JSON.stringify(received.batch.map((e) => e.event))}`);
    assert.equal(init.source, 'hook',
      "the server tells the automatic path from the MCP's by this field; 'mcp' here would defeat the memory_load check");
  });
});
