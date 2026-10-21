/**
 * v1.33.0 — the two "shown" marks must never cost the session its context, and must not be
 * sent when the hook fired for a resume or a compact.
 *
 * The marks ran before the context was written to stdout, each with a 3s timeout, while the
 * shell hook runs the script under `timeout 5`: two slow requests and the whole memory load was
 * lost. And they ran on every SessionStart source, so a /compact counted a question as asked
 * again (the server caps that at once a day; the hook should not send it at all).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';
import { markConsolidationShown, consolidationMarksOn } from '../hooks/lib/session-live-state.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_SCRIPT = path.join(repoRoot, 'hooks', 'lib', 'session-start-output.js');
const NODE_HOOK = path.join(repoRoot, 'hooks', 'ownmind-session-start.js');

const CONSOLIDATION = { card: null, report: { task_id: 40, month: '2026-10' }, questions: [{ id: 5 }] };
const MARK_URLS = ['/api/memory/consolidation/report-shown', '/api/memory/consolidation/questions/asked'];

describe('consolidationMarksOn — which SessionStart sources count as "shown"', () => {
  it('a fresh start and /clear do; a resume and a compact do not', () => {
    assert.equal(consolidationMarksOn('startup'), true);
    assert.equal(consolidationMarksOn('clear'), true);
    assert.equal(consolidationMarksOn('resume'), false);
    assert.equal(consolidationMarksOn('compact'), false);
  });

  it('a payload without a source (an older client) is a fresh start; anything unknown is not', () => {
    assert.equal(consolidationMarksOn(''), true);
    assert.equal(consolidationMarksOn(undefined), true);
    assert.equal(consolidationMarksOn(null), true);
    assert.equal(consolidationMarksOn('subagent'), false);
    assert.equal(consolidationMarksOn(42), false);
  });
});

describe('markConsolidationShown — parallel, capped, never throwing', () => {
  it('a fetch that never resolves is given up on at the cap, and both marks were in flight together', async () => {
    const started = [];
    const fetchFn = (url) => { started.push(url); return new Promise(() => {}); };
    const t0 = Date.now();
    const outcome = await markConsolidationShown({
      apiUrl: 'http://api', apiKey: 'k', fetchFn, consolidation: CONSOLIDATION, timeoutMs: 80,
    });
    const elapsed = Date.now() - t0;
    assert.deepEqual(outcome, { reportShown: false, questionsAsked: 0 });
    assert.ok(elapsed < 1000, `took ${elapsed}ms: the two caps added up instead of overlapping`);
    assert.deepEqual(started.map((u) => u.replace('http://api', '')), MARK_URLS, 'both requests started before either timed out');
  });

  it('the cap defaults to 1.5s, under the shell hook\'s 5s budget even with the pre-fetches', () => {
    assert.equal(markConsolidationShown.DEFAULT_TIMEOUT_MS, 1500);
  });
});

/**
 * A server that answers everything the two entry points ask for, except the two marks, which
 * it never answers: the hung request is the case the ordering fix exists for.
 */
function hangingServer() {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = req.url.split('?')[0];
      hits.push({ url, at: Date.now() });
      if (MARK_URLS.includes(url)) return; // never answered
      res.setHeader('content-type', 'application/json');
      // The sync-token answer carries the live consolidation too: once the Windows hook has
      // a fresh cache, that is the only place it reads the field from (conditional-sync.js).
      if (url === '/api/memory/sync-token') return res.end(JSON.stringify({ sync_token: 'tok-1', consolidation: CONSOLIDATION }));
      if (url === '/api/memory/init') {
        return res.end(JSON.stringify({
          sync_token: 'tok-1', server_version: '9.9.9-test', profile: { title: 'Vin', content: 'x', role: 'user' },
          principles: [], iron_rules_digest: 'IR-001', iron_rules_count: 1, consolidation: CONSOLIDATION,
        }));
      }
      if (url === '/api/broadcast/active' || url === '/api/handoff/pending') return res.end('[]');
      if (url === '/api/memory/sync') return res.end(JSON.stringify({ memories: [] }));
      return res.end('{}');
    });
  });
  return { server, hits };
}

function runHook(file, args, { env, stdinPayload }) {
  return new Promise((resolve, reject) => {
    let firstStdoutAt = 0;
    const child = execFile('node', [file, ...args], { env, timeout: 20000 }, (err, out, stderr) => {
      if (err) return reject(new Error(`${err.message}\n${stderr}`));
      resolve({ stdout: out, firstStdoutAt });
    });
    child.stdout.on('data', () => { if (!firstStdoutAt) firstStdoutAt = Date.now(); });
    child.stdin.end(stdinPayload === undefined ? '' : JSON.stringify(stdinPayload));
  });
}

for (const entry of [
  {
    name: 'session-start-output.js (macOS and Linux)',
    run: (source, env) => runHook(
      OUTPUT_SCRIPT,
      [JSON.stringify({ server_version: '9.9.9-test', consolidation: CONSOLIDATION }), '[]'],
      { env: { ...env, OWNMIND_HOOK_START_SOURCE: source } },
    ),
  },
  {
    name: 'ownmind-session-start.js (Windows)',
    run: (source, env) => runHook(NODE_HOOK, [], { env, stdinPayload: { session_id: 'marks', source } }),
  },
]) {
  describe(`${entry.name} — the marks come after the context, and only on a fresh start`, () => {
    let server; let hits; let baseUrl; let home; let projectDir; let env;

    before(async () => {
      ({ server, hits } = hangingServer());
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      home = tempDir('ownmind-marks-home-');
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      projectDir = tempDir('ownmind-marks-proj-');
      env = {
        ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: projectDir,
        OWNMIND_API_KEY: 'test-key-0123456789abcdef', OWNMIND_API_URL: baseUrl,
      };
    });

    after(() => {
      server?.closeAllConnections();
      server?.close();
    });

    it('startup: the context reaches stdout although the marks never resolve, and the marks follow it', async () => {
      hits.length = 0;
      const t0 = Date.now();
      const { stdout, firstStdoutAt } = await entry.run('startup', env);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
      assert.match(parsed.hookSpecificOutput.additionalContext, /2026-10/);
      const marks = hits.filter((h) => MARK_URLS.includes(h.url));
      assert.deepEqual(marks.map((h) => h.url).sort(), [...MARK_URLS].sort(), 'both marks were sent');
      // The parent sees the child's stdout and the server's request on two pipes, so their
      // order within a few ms is not reliable. What is: a mark sent *before* the write never
      // resolves here, so stdout would arrive a full cap (1.5s) after it. A write that
      // precedes the marks puts stdout well inside that window.
      for (const m of marks) assert.ok(firstStdoutAt < m.at + 1000, `${m.url} was sent ${m.at - firstStdoutAt}ms before stdout`);
      assert.ok(Date.now() - t0 < 12000, 'the hung marks must not hold the hook past its budget');
    });

    for (const source of ['resume', 'compact']) {
      it(`${source}: the context is rendered and no mark is sent`, async () => {
        hits.length = 0;
        const { stdout } = await entry.run(source, env);
        assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /2026-10/);
        assert.deepEqual(hits.filter((h) => MARK_URLS.includes(h.url)), [], `a ${source} must not count the questions as asked`);
      });
    }

    it('clear: the marks are sent', async () => {
      hits.length = 0;
      await entry.run('clear', env);
      assert.deepEqual(hits.filter((h) => MARK_URLS.includes(h.url)).map((h) => h.url).sort(), [...MARK_URLS].sort());
    });
  });
}
