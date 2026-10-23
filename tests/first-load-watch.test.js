import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

/**
 * The watcher that tells the colleague, with a desktop notification, once OwnMind has loaded
 * their memories after an install (zero-touch-install, Task 14).
 *
 * Contract: it asks GET /api/install/first-load?since=<install start> every 15 seconds. The first
 * "loaded: true" fires notify('loaded') once and stops; ten minutes without it fires
 * notify('not_loaded') once and stops. A request that throws or answers anything but 200 is just
 * another poll that found nothing. The notification must never say "loaded" unless the server did.
 */

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { watchFirstLoad, replaceRunningWatcher } = require(path.join(repoRoot, 'scripts', 'install-helpers', 'first-load-watch.cjs'));
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');

const SINCE = '2026-10-23T08:00:00Z';

/** A clock that only moves when the watcher sleeps. */
function fakeClock() {
  let t = 0;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    sleeps,
  };
}

const answer = (status, body) => ({ status, ok: status === 200, json: async () => body });
const notLoaded = async () => answer(200, { loaded: false, at: null });

/** Starts a watch with a fake clock; overrides replace any default. */
function watch(overrides = {}) {
  const clock = fakeClock();
  const notes = [];
  const requests = [];
  const promise = watchFirstLoad({
    apiUrl: 'https://om.example.com/ownmind/',
    apiKey: 'k-secret-123',
    since: SINCE,
    now: clock.now,
    sleep: clock.sleep,
    notify: (kind) => notes.push(kind),
    fetch: async (url, init) => { requests.push({ url, init }); return notLoaded(); },
    ...overrides,
  });
  return { promise, clock, notes, requests };
}

describe('watchFirstLoad', () => {
  it('notifies "loaded" once when the third poll says loaded, and asks no fourth time', async () => {
    let n = 0;
    const { promise, notes, clock } = watch({
      fetch: async () => { n += 1; return answer(200, n >= 3 ? { loaded: true, at: '2026-10-23T08:02:00Z' } : { loaded: false, at: null }); },
    });
    assert.equal(await promise, 'loaded');
    assert.deepEqual(notes, ['loaded']);
    assert.equal(n, 3);
    assert.deepEqual(clock.sleeps, [15_000, 15_000], 'sleeps only between polls, not after the last one');
  });

  it('notifies "not_loaded" once at 600 seconds when the server never says loaded, and never "loaded"', async () => {
    const { promise, notes, requests, clock } = watch();
    assert.equal(await promise, 'not_loaded');
    assert.deepEqual(notes, ['not_loaded']);
    assert.equal(clock.now(), 600_000);
    assert.equal(requests.length, 41, 'a poll every 15 s from 0 s through 600 s');
  });

  it('a request that throws, or an answer that is not 200, keeps the polling going', async () => {
    let n = 0;
    const { promise, notes } = watch({
      fetch: async () => {
        n += 1;
        if (n === 1) throw new Error('ECONNRESET');
        if (n === 2) return answer(500, { error: 'first_load_unavailable' });
        if (n === 3) return answer(401, { error: 'unauthorized' });
        if (n === 4) return answer(200, { loaded: true, at: '2026-10-23T08:01:00Z' });
        return notLoaded();
      },
    });
    assert.equal(await promise, 'loaded');
    assert.equal(n, 4);
    assert.deepEqual(notes, ['loaded']);
  });

  it('a 500 that carries loaded:true is not believed', async () => {
    const { promise, notes } = watch({ fetch: async () => answer(500, { loaded: true, at: 'x' }) });
    assert.equal(await promise, 'not_loaded');
    assert.deepEqual(notes, ['not_loaded']);
  });

  it('a server that only ever throws ends in not_loaded, once', async () => {
    const { promise, notes } = watch({ fetch: async () => { throw new Error('offline'); } });
    assert.equal(await promise, 'not_loaded');
    assert.deepEqual(notes, ['not_loaded']);
  });

  it('sends the Bearer key and the exact since, and keeps the key out of the URL', async () => {
    const seen = [];
    const run = watch({ fetch: async (url, init) => { seen.push({ url, init }); return answer(200, { loaded: true, at: SINCE }); } });
    await run.promise;
    assert.equal(seen.length, 1);
    const u = new URL(seen[0].url);
    assert.equal(u.origin + u.pathname, 'https://om.example.com/ownmind/api/install/first-load');
    assert.equal(u.searchParams.get('since'), SINCE);
    assert.equal(seen[0].init.headers.Authorization, 'Bearer k-secret-123');
    assert.ok(!seen[0].url.includes('k-secret-123'));
  });

  it('a notifier that throws does not crash the watcher', async () => {
    const { promise } = watch({
      fetch: async () => answer(200, { loaded: true, at: SINCE }),
      notify: () => { throw new Error('no notification service'); },
    });
    assert.equal(await promise, 'loaded');
  });

  it('honours timeoutMs and intervalMs', async () => {
    const { promise, requests, notes } = watch({ timeoutMs: 1000, intervalMs: 400 });
    assert.equal(await promise, 'not_loaded');
    assert.deepEqual(notes, ['not_loaded']);
    assert.equal(requests.length, 4, 'polls at 0, 400, 800 and 1000 ms');
  });
});

describe('replaceRunningWatcher (one watcher at a time)', () => {
  const pidFileIn = (dir) => {
    const pidFile = path.join(dir, 'state', 'first-load-watch.pid');
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    return pidFile;
  };

  it('kills the recorded watcher when it is still a first-load-watch process, then records its own pid', () => {
    const pidFile = pidFileIn(tempDir('watch-pid-'));
    fs.writeFileSync(pidFile, '4242\n');
    const killed = [];
    replaceRunningWatcher({
      pidFile, ownPid: 777,
      commandOf: (pid) => (pid === 4242 ? 'node /home/x/.ownmind/scripts/install-helpers/first-load-watch.cjs --since 2026' : ''),
      kill: (pid) => killed.push(pid),
    });
    assert.deepEqual(killed, [4242]);
    assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), '777');
  });

  it('leaves alone a recorded pid that now belongs to some other program', () => {
    const pidFile = pidFileIn(tempDir('watch-pid-'));
    fs.writeFileSync(pidFile, '4242\n');
    const killed = [];
    replaceRunningWatcher({ pidFile, ownPid: 777, commandOf: () => '/usr/bin/vim notes.txt', kill: (pid) => killed.push(pid) });
    assert.deepEqual(killed, []);
    assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), '777');
  });

  it('never kills itself', () => {
    const pidFile = pidFileIn(tempDir('watch-pid-'));
    fs.writeFileSync(pidFile, '777\n');
    replaceRunningWatcher({ pidFile, ownPid: 777, commandOf: () => 'node first-load-watch.cjs', kill: () => assert.fail('killed itself') });
  });

  it('works when there is no pid file yet', () => {
    const dir = tempDir('watch-pid-');
    const pidFile = path.join(dir, 'state', 'first-load-watch.pid');
    replaceRunningWatcher({ pidFile, ownPid: 5, commandOf: () => '', kill: () => assert.fail('nothing to kill') });
    assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), '5');
  });
});

describe('first-load-watch.cjs command line', { skip: process.platform === 'win32' }, () => {
  /** A server that says loaded:false once and loaded:true after, recording what it was sent. */
  async function withServer(fn) {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(seen.length >= 2 ? { loaded: true, at: new Date().toISOString() } : { loaded: false, at: null }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try { return await fn(`http://127.0.0.1:${server.address().port}`, seen); } finally { server.close(); }
  }

  function fakeHome(apiUrl, key) {
    const home = tempDir('watch-home-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      mcpServers: { ownmind: { env: { OWNMIND_API_KEY: key, OWNMIND_API_URL: apiUrl } } },
    }));
    return home;
  }

  function runCli(home, args, extraEnv = {}) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(repoRoot, 'scripts', 'install-helpers', 'first-load-watch.cjs'), ...args], {
        env: { ...process.env, HOME: home, USERPROFILE: home, OWNMIND_NOTIFY_DRY_RUN: '1', OWNMIND_LOCALE_FORCE: 'en', OWNMIND_API_KEY: '', OWNMIND_API_URL: '', ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ code, out }));
    });
  }

  const logOf = (home) => fs.readFileSync(path.join(home, '.ownmind', 'logs', 'first-load-watch.log'), 'utf8');

  it('reads the key and URL from the credentials files, never from its arguments, and logs the outcome', async () => {
    await withServer(async (apiUrl, seen) => {
      const home = fakeHome(apiUrl, 'k-from-settings-file');
      const args = ['--since', SINCE, '--interval-ms', '50', '--timeout-ms', '5000'];
      assert.ok(!args.join(' ').includes('k-from-settings-file'));
      const r = await runCli(home, args);
      assert.equal(r.code, 0);
      assert.equal(seen[0].auth, 'Bearer k-from-settings-file');
      assert.equal(new URL(seen[0].url, 'http://x').searchParams.get('since'), SINCE);
      const log = logOf(home).trim().split('\n');
      assert.equal(log.length, 1);
      assert.match(log[0], /outcome=loaded/);
      assert.ok(!log[0].includes('k-from-settings-file'));
      assert.ok(!fs.existsSync(path.join(home, '.ownmind', 'state', 'first-load-watch.pid')), 'the pid file is removed when the watcher ends');
      assert.match(r.out, /OwnMind is running and your memory has loaded\./, 'the localized sentence reached the notifier');
    });
  });

  it('says "not loaded" in the log and in the notification when the time runs out', async () => {
    const server = http.createServer((req, res) => { res.statusCode = 500; res.end('{}'); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const home = fakeHome(`http://127.0.0.1:${server.address().port}`, 'k-x');
      const r = await runCli(home, ['--since', SINCE, '--interval-ms', '20', '--timeout-ms', '200']);
      assert.equal(r.code, 0);
      assert.match(logOf(home), /outcome=not_loaded/);
      assert.match(r.out, /has not loaded your memory yet/);
      assert.ok(!/memory has loaded/.test(r.out));
    } finally { server.close(); }
  });

  it('exits 0 and logs when there are no credentials', async () => {
    const home = tempDir('watch-home-');
    const r = await runCli(home, ['--since', SINCE]);
    assert.equal(r.code, 0);
    assert.match(logOf(home), /outcome=no_credentials/);
  });

  it('exits 0 and logs when --since is missing', async () => {
    const home = tempDir('watch-home-');
    const r = await runCli(home, []);
    assert.equal(r.code, 0);
    assert.match(logOf(home), /outcome=no_since/);
  });
});

describe('notify.sh', () => {
  const script = path.join(repoRoot, 'scripts', 'install-helpers', 'notify.sh');

  it('passes the sentence to osascript as an argument, never inside the AppleScript text', () => {
    const text = read('scripts/install-helpers/notify.sh');
    assert.match(text, /item 1 of argv/);
    assert.match(text, /osascript - "\$/);
    assert.ok(!/osascript -e/.test(text), 'no -e script with the sentence spliced in');
    assert.ok(!/display notification "\$/.test(text), 'no string interpolation into AppleScript');
  });

  it('carries a sentence with double and single quotes intact (dry run prints the osascript argv)', { skip: process.platform === 'win32' }, () => {
    const sentence = 'OwnMind said "hi" and it\'s \'fine\' \\ $HOME `x`';
    const r = spawnSync('bash', [script, sentence], { env: { ...process.env, OWNMIND_NOTIFY_DRY_RUN: '1' }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.split('\n');
    assert.ok(lines.includes('argv:osascript'));
    assert.ok(lines.includes('argv:-'));
    assert.ok(lines.includes(`argv:${sentence}`), `got: ${r.stdout}`);
  });

  it('does nothing and exits 0 without a sentence', { skip: process.platform === 'win32' }, () => {
    const r = spawnSync('bash', [script], { env: { ...process.env, OWNMIND_NOTIFY_DRY_RUN: '1' }, encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

describe('notify.ps1', () => {
  const text = read('scripts/install-helpers/notify.ps1');
  it('shows a toast with the PowerShell app id, falls back to a 10 second balloon, and never throws', () => {
    assert.match(text, /Windows\.UI\.Notifications/);
    assert.match(text, /WindowsPowerShell\\v1\.0\\powershell\.exe/);
    assert.match(text, /System\.Windows\.Forms\.NotifyIcon/);
    assert.match(text, /ShowBalloonTip\(10000/);
    assert.match(text, /exit 0/);
    assert.match(text, /catch/);
  });
});

describe('installers start the watcher', () => {
  const NEXT = '# What the AI does next';

  it('install.sh: detached, after the self-check, before the NEXT decision, guarded, key not on the command line', () => {
    const t = read('install.sh');
    const selfCheck = t.indexOf('--trigger=post_install');
    const nohupAt = t.indexOf('nohup', selfCheck);
    const nextAt = t.indexOf(NEXT);
    assert.ok(selfCheck !== -1 && nohupAt !== -1 && nextAt !== -1);
    assert.ok(selfCheck < nohupAt && nohupAt < nextAt, 'self-check, then the watcher, then NEXT');
    const lineStart = t.lastIndexOf('\n', nohupAt) + 1;
    const spawnLine = t.slice(lineStart, t.indexOf('\n', lineStart)).trim();
    assert.match(spawnLine, /^nohup "\$WATCH_NODE" "\$WATCH_SCRIPT" --since "\$OWNMIND_INSTALL_STARTED_AT" <\/dev\/null >\/dev\/null 2>&1 &$/);
    assert.ok(!/KEY/i.test(spawnLine), 'the key is not in the spawn command');
    assert.match(t, /WATCH_SCRIPT="\$OWNMIND_DIR\/scripts\/install-helpers\/first-load-watch\.cjs"/);
    assert.match(t.slice(selfCheck, nohupAt), /OWNMIND_SKIP_FIRST_LOAD_WATCH:-\}" != 1/);
    assert.match(t, /OWNMIND_INSTALL_STARTED_AT="\$\(date -u \+%Y-%m-%dT%H:%M:%SZ\)"/);
    assert.ok(t.indexOf('OWNMIND_INSTALL_STARTED_AT=') < t.indexOf('# --- 1. Clone MCP Server ---'), 'the timestamp is taken at the start of the run');
    assert.match(t.slice(nohupAt, nextAt), /disown/);
  });

  it('install.ps1: hidden Start-Process after the self-check and before the NEXT decision, guarded, key not in the arguments', () => {
    const t = read('install.ps1');
    const selfCheck = t.indexOf('--trigger=post_install');
    const spawnAt = t.indexOf('Start-Process', selfCheck);
    const nextAt = t.indexOf(NEXT);
    assert.ok(selfCheck !== -1 && spawnAt !== -1 && nextAt !== -1);
    assert.ok(selfCheck < spawnAt && spawnAt < nextAt);
    const block = t.slice(selfCheck, nextAt);
    assert.match(block, /-WindowStyle Hidden/);
    assert.match(block, /first-load-watch\.cjs/);
    assert.match(block, /OWNMIND_SKIP_FIRST_LOAD_WATCH -ne '1'/);
    const startLine = block.split('\n').find((l) => l.includes('Start-Process'));
    assert.ok(!/key/i.test(startLine), 'the key is not in the spawn command');
    assert.match(t, /\$InstallStartedAt = \(Get-Date\)\.ToUniversalTime\(\)\.ToString\('yyyy-MM-ddTHH:mm:ssZ', \[System\.Globalization\.CultureInfo\]::InvariantCulture\)/);
    assert.ok(t.indexOf('$InstallStartedAt =') < t.indexOf('$SelfCheckScript ='), 'the timestamp is taken before the self-check, at the start of the run');
  });

  it('the upgrade paths do not start a watcher', () => {
    assert.match(read('shared/archive-update.js'), /OWNMIND_SKIP_FIRST_LOAD_WATCH/);
    assert.match(read('scripts/interactive-upgrade.sh'), /OWNMIND_SKIP_FIRST_LOAD_WATCH=1[^\n]*bash install\.sh/);
    assert.match(read('scripts/interactive-upgrade.ps1'), /\$env:OWNMIND_SKIP_FIRST_LOAD_WATCH = '1'/);
  });
});
