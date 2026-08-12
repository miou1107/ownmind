import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { fetchHookContext } from '../hooks/lib/hook-context-fetch.js';

/**
 * The API wraps its responses as { data: [...] }. Three hooks read that endpoint:
 *
 *   hooks/ownmind-iron-rule-check.js   — fixed in v1.19.20
 *   hooks/ownmind-iron-rule-check.sh   — missed; threw on every run, output swallowed
 *   hooks/ownmind-git-pre-commit.js    — missed; yielded nothing, silently
 *
 * The .sh variant is the one wired into a real installation's settings.json, so its failure
 * meant no iron-rule reminders at all.
 *
 * v1.26.151 moved both parses out of the files that used to carry them: the shell hook's
 * inline `node -e` became hooks/ownmind-render-context.js, and the .js hook's fetch became
 * hooks/lib/hook-context-fetch.js. These tests moved with them, and stopped grepping for the
 * source line in the process — they now run the real thing against both shapes, which is
 * what they were trying to approximate. A regex that matches a parse it never executes can
 * pass while the parse is unreachable.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const RULE = { code: 'IR-008', tags: ['trigger:commit'], title: 'x', content: 'y' };
const WRAPPED = JSON.stringify({ data: [RULE] });
const BARE = JSON.stringify([RULE]);

describe('the shell hook path unwraps the response envelope', () => {
  /** Run the renderer the .sh hook pipes its response body into. */
  function render(body) {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [path.join(repoRoot, 'hooks', 'ownmind-render-context.js'), '9.9.9', 'commit'],
        { stdio: 'pipe' }
      );
      let stdout = '';
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout }));
      child.stdin.end(body);
    });
  }

  it('reads the wrapped shape', async () => {
    const r = await render(WRAPPED);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /1 條規則已確認/, 'the one commit-tagged rule must be counted');
  });

  it('still reads a bare array', async () => {
    const r = await render(BARE);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /1 條規則已確認/);
  });

  it('the old parse would have thrown on the wrapped shape', () => {
    // The defect, reproduced: this is what the script did before v1.26.87.
    assert.throws(() => {
      const parsed = JSON.parse(WRAPPED);
      parsed.filter(() => true);
    }, TypeError);
  });
});

describe('the JS hook path keeps its v1.19.20 fix', () => {
  let server;
  let baseUrl;
  let body;

  before(async () => {
    server = http.createServer((req, res) => {
      // Only the legacy endpoint answers, so every request lands on the fallback — which is
      // the path that has to unwrap, because it is the one talking to the old shape.
      if (req.url.includes('/api/memory/type/iron_rule')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('handles the wrapped shape', async () => {
    body = WRAPPED;
    const ctx = await fetchHookContext({ apiUrl: baseUrl, apiKey: 'k', trigger: 'commit' });
    assert.equal(ctx.legacy, true);
    assert.equal(ctx.rules.length, 1);
    assert.equal(ctx.counts.iron_rule, 1);
  });

  it('handles a bare array', async () => {
    body = BARE;
    const ctx = await fetchHookContext({ apiUrl: baseUrl, apiKey: 'k', trigger: 'commit' });
    assert.equal(ctx.rules.length, 1);
  });
});
