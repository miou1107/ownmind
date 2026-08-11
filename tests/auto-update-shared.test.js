// v1.26.142 — the upgrade had exactly one trigger, and it was an AI tool.
//
// `git fetch` → `git pull` → `npm install` → the sync script lived only inside mcp/index.js
// and ran when a tool opened an MCP session with OwnMind. The two SessionStart hooks run
// the sync script alone, which repairs an installation but never advances it.
//
// So a machine upgraded if and only if somebody opened a tool that speaks MCP to OwnMind.
// One member's records: a scanner checking in on schedule every day since June, still on
// the version she installed that day, because the editor she works in is not one of them.
// Nothing on that machine was broken. There was nobody to ask it to update.
//
// The scheduled scanner runs on every platform, on a timer, with no AI tool and no model
// involved. These tests cover the implementation both callers now share.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { runAutoUpdate, SKIPPED, CLEAN, APPLIED, FAILED } =
  await import('../shared/auto-update.js');

let ROOT;
let dir;

beforeEach(async () => {
  ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'ownmind-autoupdate-'));
  dir = path.join(ROOT, '.ownmind');
  await fsp.mkdir(path.join(dir, '.git'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({ version: '1.26.142' }));
});
afterEach(async () => {
  await fsp.rm(ROOT, { recursive: true, force: true });
});

/**
 * An execFile that records what it was asked to run and answers from a script.
 *
 * `pending` decides whether `git log HEAD..origin/main` reports new commits, which is the
 * branch between "nothing to do" and a real upgrade.
 */
function fakeExec({ pending = '', failOn = null, failWith = new Error('boom') } = {}) {
  const calls = [];
  const execFile = async (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args, opts });
    const label = `${cmd} ${args[0] ?? ''}`.trim();
    if (failOn && label.startsWith(failOn)) throw failWith;
    if (cmd === 'git' && args[0] === 'log') return { stdout: pending, stderr: '' };
    return { stdout: '', stderr: '' };
  };
  return { calls, execFile };
}

function harness(overrides = {}) {
  const events = [];
  const banners = [];
  return {
    events,
    banners,
    opts: {
      ownmindDir: dir,
      markerFile: path.join(dir, '.last-mcp-update-check'),
      lockFile: path.join(dir, '.update-lock'),
      source: 'scanner',
      logEvent: (event, details) => events.push({ event, details }),
      queueBanner: (b) => banners.push(b),
      today: () => '2026-08-11',
      ...overrides
    }
  };
}

describe('when the upgrade does not run', () => {
  it('skips a day it has already checked', async () => {
    await fsp.writeFile(path.join(dir, '.last-mcp-update-check'), '2026-08-11');
    const { execFile, calls } = fakeExec();
    const h = harness();
    const out = await runAutoUpdate({ ...h.opts, execFile });
    assert.equal(out.outcome, SKIPPED);
    assert.equal(out.reason, 'marker_today');
    assert.equal(calls.length, 0, 'nothing may be executed on a day already settled');
  });

  it('runs on a marker from yesterday', async () => {
    await fsp.writeFile(path.join(dir, '.last-mcp-update-check'), '2026-08-10');
    const { execFile, calls } = fakeExec();
    const h = harness();
    const out = await runAutoUpdate({ ...h.opts, execFile });
    assert.equal(out.outcome, CLEAN);
    assert.ok(calls.some((c) => c.cmd === 'git' && c.args[0] === 'fetch'));
  });

  it('skips a directory that is not a git checkout', async () => {
    await fsp.rm(path.join(dir, '.git'), { recursive: true, force: true });
    const { execFile, calls } = fakeExec();
    const h = harness();
    const out = await runAutoUpdate({ ...h.opts, execFile });
    assert.equal(out.outcome, SKIPPED);
    assert.equal(out.reason, 'no_git_dir');
    assert.equal(calls.length, 0);
  });

  it('stands aside for whoever holds the lock, and does not release it', async () => {
    // The MCP, both hooks and the scanner take this one lock. A second releaser is how a
    // process ends up releasing somebody else's.
    const lockFile = path.join(dir, '.update-lock');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    const { execFile, calls } = fakeExec();
    const h = harness();
    const out = await runAutoUpdate({ ...h.opts, execFile });
    assert.equal(out.outcome, SKIPPED);
    assert.equal(out.reason, 'lock_held');
    assert.equal(calls.length, 0);
    assert.equal(fs.existsSync(lockFile), true, "the holder's lock must survive");
  });
});

describe('when there is nothing new upstream', () => {
  it('reports clean, stamps the day, and does not pull', async () => {
    const { execFile, calls } = fakeExec({ pending: '' });
    const h = harness();
    const out = await runAutoUpdate({ ...h.opts, execFile });
    assert.equal(out.outcome, CLEAN);
    assert.equal(calls.some((c) => c.args[0] === 'pull'), false);
    assert.equal(fs.readFileSync(path.join(dir, '.last-mcp-update-check'), 'utf8'), '2026-08-11');
    assert.ok(h.events.some((e) => e.event === 'update_clean'));
  });

  it('releases the lock', async () => {
    const { execFile } = fakeExec({ pending: '' });
    const h = harness();
    await runAutoUpdate({ ...h.opts, execFile });
    assert.equal(fs.existsSync(path.join(dir, '.update-lock')), false);
  });
});

describe('when there are new commits', () => {
  it('runs the whole chain in order and reports the version now on disk', async () => {
    const { execFile, calls } = fakeExec({ pending: 'abc1234 something' });
    const h = harness();
    const out = await runAutoUpdate({ ...h.opts, execFile, platform: 'darwin' });
    assert.equal(out.outcome, APPLIED);
    assert.equal(out.version, '1.26.142');
    assert.deepEqual(calls.map((c) => `${c.cmd} ${c.args[0]}`), [
      'git fetch',
      'git log',
      'git pull',
      'npm install',
      `bash ${path.join(dir, 'scripts', 'update.sh')}`
    ]);
    assert.ok(h.banners.some((b) => b.outcome === 'applied' && b.version === '1.26.142'));
  });

  it('falls back to --ff-only when --autostash is refused', async () => {
    // The fallback deliberately drops --autostash. Before v1.26.65 both paths passed it,
    // so on git older than 2.6 both failed and there was effectively no fallback.
    const calls = [];
    let firstPull = true;
    const execFile = async (cmd, args = []) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'git' && args[0] === 'log') return { stdout: 'abc1234 x', stderr: '' };
      if (cmd === 'git' && args[0] === 'pull' && firstPull) {
        firstPull = false;
        throw new Error('unknown option: --autostash');
      }
      return { stdout: '', stderr: '' };
    };
    const h = harness();
    const out = await runAutoUpdate({ ...h.opts, execFile, platform: 'darwin' });
    assert.equal(out.outcome, APPLIED);
    assert.ok(calls.includes('git pull -q --ff-only'));
  });

  it('uses PowerShell and the shell for npm on Windows', async () => {
    // Since the CVE-2024-27980 patch, execFile refuses .cmd/.bat without a shell. That
    // surfaced as `update_failed step=npm error=EINVAL` on Windows only.
    const { execFile, calls } = fakeExec({ pending: 'abc1234 x' });
    const h = harness();
    await runAutoUpdate({ ...h.opts, execFile, platform: 'win32' });
    const npm = calls.find((c) => c.cmd === 'npm.cmd');
    assert.ok(npm, 'Windows must invoke npm.cmd, not npm');
    assert.equal(npm.opts.shell, true);
    assert.ok(calls.some((c) => c.cmd === 'powershell.exe'
      && c.args.includes(path.join(dir, 'scripts', 'update.ps1'))));
  });
});

describe('when a step fails', () => {
  for (const [failOn, step] of [
    ['git fetch', 'fetch'],
    ['git log', 'log'],
    ['npm install', 'npm']
  ]) {
    it(`reports step=${step} and releases the lock`, async () => {
      const { execFile } = fakeExec({ pending: 'abc1234 x', failOn });
      const h = harness();
      const out = await runAutoUpdate({ ...h.opts, execFile, platform: 'darwin' });
      assert.equal(out.outcome, FAILED);
      assert.equal(out.step, step);
      assert.equal(fs.existsSync(path.join(dir, '.update-lock')), false);
      assert.ok(h.events.some((e) => e.event === 'update_failed' && e.details.step === step));
      assert.ok(h.banners.some((b) => b.outcome === 'failed' && b.step === step));
    });
  }

  it('leaves the day unstamped, so the next run tries again', async () => {
    // Stamping a failure would cost the machine a whole day for a transient network
    // problem, on machines whose whole issue is that they never get a second chance.
    const { execFile } = fakeExec({ failOn: 'git fetch' });
    const h = harness();
    await runAutoUpdate({ ...h.opts, execFile });
    assert.equal(fs.existsSync(path.join(dir, '.last-mcp-update-check')), false);
  });

  it('reports both pull attempts failing as step=pull', async () => {
    const { execFile } = fakeExec({ pending: 'abc1234 x', failOn: 'git pull' });
    const h = harness();
    const out = await runAutoUpdate({ ...h.opts, execFile, platform: 'darwin' });
    assert.equal(out.step, 'pull');
  });
});

describe('the caller hook that runs after a successful upgrade', () => {
  it('is handed the version now on disk', async () => {
    const seen = [];
    const { execFile } = fakeExec({ pending: 'abc1234 x' });
    const h = harness();
    await runAutoUpdate({
      ...h.opts, execFile, platform: 'darwin',
      onApplied: async (v) => { seen.push(v); }
    });
    assert.deepEqual(seen, ['1.26.142']);
  });

  it('does not turn its own failure into a failed upgrade', async () => {
    // The upgrade has happened by this point. A heartbeat that cannot be sent afterwards
    // is worth an event, not a rollback of the verdict.
    const { execFile } = fakeExec({ pending: 'abc1234 x' });
    const h = harness();
    const out = await runAutoUpdate({
      ...h.opts, execFile, platform: 'darwin',
      onApplied: async () => { throw new Error('offline'); }
    });
    assert.equal(out.outcome, APPLIED);
    assert.ok(h.events.some((e) => e.event === 'update_heartbeat_failed'));
  });
});
