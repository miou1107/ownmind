/**
 * "Your report has been fixed" reached Windows and nobody else.
 *
 * Closing a bug report sets `notified_to_reporter = false`, and `GET
 * /api/bug-reports/notifications` hands the reporter back the resolutions they have not seen.
 * Only `hooks/ownmind-session-start.js` ever called it, and session-hook-command.cjs registers
 * that file on Windows alone — macOS and Linux run `ownmind-session-start.sh`, which fetches
 * broadcasts and never fetched this. So the two people who filed the reports fixed in v1.30.18
 * were never going to be told.
 *
 * Same shape as the defect v1.26.83 repaired in the other direction, where the .js hook was the
 * one missing broadcasts. One channel written into one platform's copy is the pattern; the fix
 * is a module both copies call, not a second copy.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { stageHookHome } from './helpers/hook-home.js';
import { startServer } from './helpers/app-server.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Async, deliberately: execFileSync blocks this process's event loop, so the stub server
// below would never accept the child's connection and every case would fail on the timeout.
const run = promisify(execFile);
const {
  roleForProfile, bugReportNotificationLines, fetchBugReportNotifications,
} = await import('../hooks/lib/bug-report-notifications.js');
const { renderSessionContext } = await import('../hooks/lib/render-session-context.js');

describe('which half of the endpoint to ask for', () => {
  it('an ordinary member asks only about their own reports', () => {
    // role=both is a 403 for a non-admin, and a 403 here would lose the reporter half too.
    assert.equal(roleForProfile({ role: 'member' }), 'reporter');
    assert.equal(roleForProfile({}), 'reporter');
    assert.equal(roleForProfile(undefined), 'reporter');
  });

  it('an admin asks for both halves', () => {
    assert.equal(roleForProfile({ role: 'admin' }), 'both');
    assert.equal(roleForProfile({ role: 'super_admin' }), 'both');
  });
});

describe('what the reader is told', () => {
  it('a resolved report of mine is named', () => {
    const lines = bugReportNotificationLines({
      reporter: { unread_resolved_count: 2, recent_resolved: [] },
    });
    assert.match(lines.join('\n'), /2 of your reports have been resolved/);
  });

  it('an admin also hears what is waiting', () => {
    const lines = bugReportNotificationLines({
      admin: { unhandled_count: 3, recent_unhandled: [] },
      reporter: { unread_resolved_count: 1, recent_resolved: [] },
    });
    const text = lines.join('\n');
    assert.match(text, /3 unhandled bug reports/);
    assert.match(text, /1 of your reports have been resolved/);
  });

  it('nothing to say produces no section at all', () => {
    assert.deepEqual(bugReportNotificationLines({ reporter: { unread_resolved_count: 0 } }), []);
    assert.deepEqual(bugReportNotificationLines(null), []);
    assert.deepEqual(bugReportNotificationLines({}), []);
  });
});

describe('fetching it never costs anyone their session', () => {
  const creds = { apiUrl: 'https://example.test', apiKey: 'k' };

  it('asks the endpoint for the role it was given', async () => {
    let seen = '';
    await fetchBugReportNotifications({
      ...creds,
      role: 'both',
      httpGet: async (url) => { seen = url; return '{}'; },
    });
    assert.match(seen, /\/api\/bug-reports\/notifications\?role=both$/);
  });

  it('a failed request answers null rather than throwing', async () => {
    const out = await fetchBugReportNotifications({
      ...creds, role: 'reporter', httpGet: async () => { throw new Error('offline'); },
    });
    assert.equal(out, null);
  });

  it('a reply that is not JSON answers null', async () => {
    const out = await fetchBugReportNotifications({
      ...creds, role: 'reporter', httpGet: async () => '<html>502</html>',
    });
    assert.equal(out, null);
  });

  it('no credentials means no request', async () => {
    let called = false;
    const out = await fetchBugReportNotifications({
      apiUrl: '', apiKey: '', role: 'reporter', httpGet: async () => { called = true; return '{}'; },
    });
    assert.equal(out, null);
    assert.equal(called, false);
  });
});

describe('the rendered session context carries it', () => {
  it('the section appears when there is something to say', () => {
    const out = renderSessionContext({ server_version: '1.30.18' }, [], {
      notifications: { reporter: { unread_resolved_count: 1, recent_resolved: [] } },
    });
    assert.match(out, /Bug report notifications/);
    assert.match(out, /1 of your reports have been resolved/);
  });

  it('and is absent when it is not passed at all', () => {
    const out = renderSessionContext({ server_version: '1.30.18' }, []);
    assert.doesNotMatch(out, /Bug report notifications/);
  });
});

describe('the macOS and Linux path reaches it end to end', () => {
  it('session-start-output.js renders the section from what it is handed', () => {
    // The .sh hands this script the init payload, the broadcasts and now the notifications.
    // Asserting on the process output rather than on the function keeps the argv contract in
    // the test: the .sh passes positionally, and a signature change there is silent.
    const out = execFileSync('node', [
      path.join(repoRoot, 'hooks', 'lib', 'session-start-output.js'),
      JSON.stringify({ server_version: '1.30.18' }),
      '[]',
      JSON.stringify({ reporter: { unread_resolved_count: 2, recent_resolved: [] } }),
    ], { encoding: 'utf8' });

    const parsed = JSON.parse(out);
    assert.match(parsed.hookSpecificOutput.additionalContext, /2 of your reports have been resolved/);
  });

  it('a malformed notifications argument is ignored, not fatal', () => {
    const out = execFileSync('node', [
      path.join(repoRoot, 'hooks', 'lib', 'session-start-output.js'),
      JSON.stringify({ server_version: '1.30.18' }), '[]', 'not json',
    ], { encoding: 'utf8' });

    assert.doesNotMatch(JSON.parse(out).hookSpecificOutput.additionalContext, /Bug report/);
  });

  it('the script the shell hook runs is the one that fetches', () => {
    // The shell hook is unchanged: it still calls session-start-output.js with the init payload
    // and the broadcasts. Deciding the role needs profile.role, which is only parsed inside
    // that script, so the fetch lives there rather than in bash.
    const sh = fs.readFileSync(path.join(repoRoot, 'hooks', 'ownmind-session-start.sh'), 'utf8');
    assert.match(sh, /session-start-output\.js" "\$INIT_DATA" "\$BROADCAST_DATA"/,
      'the shell hook no longer runs the renderer this change relies on');

    const out = fs.readFileSync(path.join(repoRoot, 'hooks', 'lib', 'session-start-output.js'), 'utf8');
    assert.match(out, /fetchBugReportNotifications/,
      'the macOS and Linux path never asks for the notifications');
    assert.match(out, /roleForProfile/,
      'the role has to come from profile.role, or an admin loses their half');
  });
});

describe('a machine with credentials really gets told', () => {
  /**
   * A stand-in for the endpoint, so the assertion is on the whole path and not on a stub.
   * Through startServer, because listen(0) occasionally hands back a port `fetch` refuses to
   * dial at all — see tests/helpers/app-server.js for the measurement.
   */
  const serveOnce = (handler) => startServer(http.createServer(handler));

  it('the mac and Linux path fetches and renders it, credentials and all', async () => {
    let askedFor = '';
    const srv = await serveOnce((req, res) => {
      askedFor = req.url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reporter: { unread_resolved_count: 3, recent_resolved: [] } }));
    });
    const home = stageHookHome({ apiUrl: srv.url, apiKey: 'k' });

    try {
      // No third argument: this is exactly what ownmind-session-start.sh runs.
      const { stdout } = await run('node', [
        path.join(repoRoot, 'hooks', 'lib', 'session-start-output.js'),
        JSON.stringify({ server_version: '1.30.18', profile: { role: 'member' } }),
        '[]',
      ], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });

      assert.equal(askedFor, '/api/bug-reports/notifications?role=reporter');
      assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext,
        /3 of your reports have been resolved/);
    } finally {
      await srv.close();
    }
  });

  it('an admin on the same path is asked about both halves', async () => {
    let askedFor = '';
    const srv = await serveOnce((req, res) => {
      askedFor = req.url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    const home = stageHookHome({ apiUrl: srv.url, apiKey: 'k' });

    try {
      await run('node', [
        path.join(repoRoot, 'hooks', 'lib', 'session-start-output.js'),
        JSON.stringify({ server_version: '1.30.18', profile: { role: 'admin' } }), '[]',
      ], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });

      assert.equal(askedFor, '/api/bug-reports/notifications?role=both');
    } finally {
      await srv.close();
    }
  });

  it('a server that answers 500 costs the section and nothing else', async () => {
    const srv = await serveOnce((req, res) => { res.writeHead(500); res.end('nope'); });
    const home = stageHookHome({ apiUrl: srv.url, apiKey: 'k' });

    try {
      const { stdout } = await run('node', [
        path.join(repoRoot, 'hooks', 'lib', 'session-start-output.js'),
        JSON.stringify({ server_version: '1.30.18' }), '[]',
      ], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });

      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      assert.doesNotMatch(ctx, /Bug report notifications/);
      assert.match(ctx, /Memory loaded/, 'the rest of the session context still has to print');
    } finally {
      await srv.close();
    }
  });
});

describe('both platform hooks read the one implementation', () => {
  it('neither entry point carries its own copy of the wording', () => {
    // The wording lived inline in the .js hook. A second copy in the shell path is how the two
    // drift, so the entry points must both go through the module.
    // Naming the file is not using it: the import line alone satisfied the first version of
    // this, so deleting the call in either hook left the suite green while that platform lost
    // the section. Each entry is the call that has to survive in that file.
    const mustCall = [
      [path.join('hooks', 'ownmind-session-start.js'), /notifications:\s*notif\b/],
      [path.join('hooks', 'lib', 'render-session-context.js'), /bugReportNotificationLines\(notifications\)/],
      [path.join('hooks', 'lib', 'session-start-output.js'), /await fetchBugReportNotifications\(/],
    ];
    for (const [rel, call] of mustCall) {
      const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      assert.match(src, /bug-report-notifications\.js/, `${rel} does not read the shared module`);
      assert.match(src, call, `${rel} imports the shared module but never uses it`);
      assert.doesNotMatch(src, /of your reports have been resolved/,
        `${rel} still spells the sentence out itself`);
    }
  });
});

describe('a network that swallows packets must not cost the whole load', () => {
  /**
   * `AbortSignal.timeout` rejects the fetch at 3s but leaves the TCP connect pending, so the
   * process used to live 10.66s — measured — against a hook registered with a 10s timeout.
   * Bash was killed mid-way and the entire context injection went with it, along with the
   * memory-file sync that runs after it in the shell hook.
   */
  /**
   * TEST-NET-1: reserved for documentation, so nothing answers. On a normal network the SYN is
   * dropped rather than refused, which is the case that used to hold the process open — a stub
   * on 127.0.0.1 always *accepts*, so it cannot reproduce this and a test built on one passes
   * whether the fix is there or not (measured: the mutation went undetected).
   *
   * Where the environment refuses instead of dropping, this proves nothing, so it says so and
   * skips rather than reporting a pass it did not earn.
   */
  const BLACKHOLE = 'http://192.0.2.1:8080';

  async function blackholeDropsPackets() {
    const started = Date.now();
    try {
      await fetch(BLACKHOLE, { signal: AbortSignal.timeout(1200) });
      return false;
    } catch {
      return Date.now() - started > 900;
    }
  }

  it('a connect that never completes does not outlive the hook budget', async () => {
    if (!await blackholeDropsPackets()) {
      // Not a silent pass: the assertion below is meaningless here and the run says why.
      console.log('# skipped: this network refuses 192.0.2.1 rather than dropping it');
      return;
    }
    const home = stageHookHome({ apiUrl: BLACKHOLE, apiKey: 'k' });

    const started = Date.now();
    const { stdout } = await run('node', [
      path.join(repoRoot, 'hooks', 'lib', 'session-start-output.js'),
      JSON.stringify({ server_version: '1.30.18' }), '[]',
    ], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 8000,
      `took ${elapsed}ms; the hook is registered with a 10s timeout and the shell script still has `
      + 'the memory-file sync to run after this');
    assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /Memory loaded/);
  });

  it('a server that accepts and never answers still lets the hook finish in time', async () => {
    const held = [];
    const raw = http.createServer(() => { /* accept, never respond */ });
    raw.on('connection', (s) => held.push(s));
    const server = await startServer(raw);
    const home = stageHookHome({ apiUrl: server.url, apiKey: 'k' });

    const started = Date.now();
    try {
      const { stdout } = await run('node', [
        path.join(repoRoot, 'hooks', 'lib', 'session-start-output.js'),
        JSON.stringify({ server_version: '1.30.18' }), '[]',
      ], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
      const elapsed = Date.now() - started;

      assert.ok(elapsed < 8000,
        `took ${elapsed}ms; the hook is registered with a 10s timeout and the rest of the shell script needs the room`);
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      assert.match(ctx, /Memory loaded/, 'the load has to survive a stalled server');
      assert.doesNotMatch(ctx, /Bug report notifications/);
    } finally {
      for (const s of held) s.destroy();
      await server.close();
    }
  });

  it('stdout is complete, not cut off at the pipe buffer', async () => {
    // Exiting inside the write callback is what bounds the process. Exiting straight after the
    // write truncates at 64 KB through a pipe, which would corrupt the JSON on any machine with
    // a large memory set.
    const home = stageHookHome({ apiUrl: 'http://127.0.0.1:1', apiKey: 'k' });
    const bigBroadcast = [{ title: 'x', severity: 'info', body: 'y'.repeat(1900) }];

    const { stdout } = await run('node', [
      path.join(repoRoot, 'hooks', 'lib', 'session-start-output.js'),
      JSON.stringify({ server_version: '1.30.18' }), JSON.stringify(bigBroadcast), '{}',
    ], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, env: { ...process.env, HOME: home, USERPROFILE: home } });

    const parsed = JSON.parse(stdout);
    assert.match(parsed.hookSpecificOutput.additionalContext, /y{1900}/,
      'the tail of the output did not survive the exit');
  });
});

describe('the Windows path keeps working', () => {
  it('the .js hook renders the section too, in the same place', async () => {
    let askedFor = '';
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/api/memory/init')) {
        return res.end(JSON.stringify({
          server_version: '9.9.9-test', profile: { role: 'member' },
          principles: [], iron_rules_digest: '', memories: [],
        }));
      }
      if (req.url.startsWith('/api/bug-reports/notifications')) {
        askedFor = req.url;
        return res.end(JSON.stringify({ reporter: { unread_resolved_count: 4, recent_resolved: [] } }));
      }
      return res.end(req.url.includes('broadcast') ? '[]' : '{}');
    });
    const started = await startServer(server);
    const baseUrl = started.url;
    const home = stageHookHome({ apiUrl: baseUrl, apiKey: 'test-key-0123456789abcdef' });

    try {
      const stdout = await new Promise((resolve, reject) => {
        const child = execFile('node', [path.join(repoRoot, 'hooks', 'ownmind-session-start.js')], {
          env: {
            ...process.env, HOME: home, USERPROFILE: home,
            OWNMIND_API_KEY: 'test-key-0123456789abcdef', OWNMIND_API_URL: baseUrl,
          },
          timeout: 20000,
        }, (err, out, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(out)));
        // execFile leaves stdin open and the hook reads it to EOF, so it would wait for ever.
        child.stdin.end(JSON.stringify({ session_id: 'win-notif', hook_event_name: 'SessionStart' }));
      });

      assert.equal(askedFor, '/api/bug-reports/notifications?role=reporter');
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      assert.match(ctx, /4 of your reports have been resolved/,
        'the platform that already worked lost the section');
      assert.ok(ctx.indexOf('Bug report notifications') < ctx.indexOf('Tip (relay this one'),
        'both platforms have to place the section identically, or the layouts drift again');
    } finally {
      await started.close();
    }
  });
});
