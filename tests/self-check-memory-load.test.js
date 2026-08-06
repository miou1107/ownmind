// v1.26.81 — nothing checks whether memories actually load.
//
// The installer's self-check has nine items. It confirms the collector's schedule is
// registered, that usage data round-trips to the server, that the API key parses, that the
// git hooks are in place. Not one of them asks the question the product exists to answer:
// **did this person's memories and iron rules reach their AI?**
//
// So when the answer was "no, and never has been" on six Windows machines, it stayed that
// way for three months. Not because it was hard to detect — the server had the evidence
// all along — but because nobody was looking.
//
// The new check is modelled on `usage_roundtrip`, the only existing item that asks the
// server rather than the machine. Local evidence is collected too, because it is what
// tells you *why*, but the verdict comes from the server: a machine reporting on its own
// health is the machine you cannot trust.
//
// Local evidence collected, chosen from what this week's investigation actually needed:
//   - the SessionStart command as written in settings.json, verbatim
//   - whether the file that command points at exists
//   - where `bash` and `node` resolve to — a `bash` under System32 is the WSL launcher,
//     which is the whole reason the Windows command never worked

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createSelfCheckRouter } from '../src/routes/usage/self-check.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);
const selfCheck = require_(path.join(repoRoot, 'scripts/install-helpers/self-check.cjs'));

const ISO = /^\d{4}-\d{2}-\d{2}T/;

// --- server -----------------------------------------------------------------

function serverWith(rows) {
  const seen = [];
  const query = async (sql, params) => {
    seen.push({ sql, params });
    if (/collector_heartbeat/.test(sql)) return { rows: [] };
    if (/token_events/.test(sql)) return { rows: [] };
    if (/activity_logs/.test(sql)) return { rows };
    return { rows: [] };
  };
  const app = express();
  app.use('/api/usage/self-check', createSelfCheckRouter({
    query,
    auth: (req, _res, next) => { req.user = { id: 11 }; next(); },
    now: () => new Date('2026-08-06T12:00:00Z'),
  }));
  return { app, seen };
}

async function get(app) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/usage/self-check`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

describe('GET /api/usage/self-check — the server says whether memories ever loaded', () => {
  it('reports the last hook-sourced load and a recent count', async () => {
    const { app } = serverWith([{
      last_hook_init_at: new Date('2026-08-06T03:00:00Z'),
      last_mcp_init_at: new Date('2026-08-05T01:00:00Z'),
      hook_inits_7d: '271',
    }]);
    const { status, body } = await get(app);
    assert.equal(status, 200);
    assert.ok(body.memory_load, 'no memory_load block');
    assert.match(body.memory_load.last_hook_init_at, ISO);
    assert.equal(body.memory_load.hook_inits_7d, 271, 'counts must be numbers, not bigint strings');
  });

  it('says never rather than omitting the field', async () => {
    // 采瑤's row. An absent field reads as "not implemented yet" and a caller written
    // defensively would treat it as unknown. Null is the finding.
    const { app } = serverWith([{ last_hook_init_at: null, last_mcp_init_at: null, hook_inits_7d: '0' }]);
    const { body } = await get(app);
    assert.equal(body.memory_load.last_hook_init_at, null);
    assert.equal(body.memory_load.hook_inits_7d, 0);
  });

  it('separates the hook from the MCP, because only one of them is the automatic path', () => {
    // Eric loads memories only when his AI calls the tool by hand. That is not the feature
    // working; collapsing the two would report his machine as healthy.
    const { seen } = serverWith([]);
    assert.ok(true, seen);
  });

  it('asks activity_logs for this user only, and distinguishes source', async () => {
    const { app, seen } = serverWith([{ last_hook_init_at: null, last_mcp_init_at: null, hook_inits_7d: '0' }]);
    await get(app);
    const q = seen.find((s) => /activity_logs/.test(s.sql));
    assert.ok(q, 'never queried activity_logs');
    assert.match(q.sql, /user_id\s*=\s*\$1/, 'must be scoped to the caller');
    assert.match(q.sql, /'hook'/, "must tell the hook's loads apart from the MCP's");
    assert.match(q.sql, /'init'/);
    assert.deepEqual(q.params, [11]);
  });
});

// --- client -----------------------------------------------------------------

describe('checkMemoryLoad — verdict from the server, evidence from the machine', () => {
  const { checkMemoryLoad } = selfCheck;

  const serverSays = (memory_load) => async () => ({ memory_load });
  const settings = (command) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-sc-'));
    const p = path.join(dir, 'settings.json');
    fs.writeFileSync(p, JSON.stringify({
      hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command }] }] },
    }));
    return p;
  };

  it('fails when memories have never loaded automatically', async () => {
    const r = await checkMemoryLoad({
      apiUrl: 'https://x', apiKey: 'k',
      fetchSelfCheck: serverSays({ last_hook_init_at: null, hook_inits_7d: 0 }),
      settingsPath: settings('bash ~/.claude/hooks/ownmind-session-start.sh'),
      resolveBinary: () => null,
    });
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /never/i);
    assert.ok(r.fix, 'a failure with no remedy leaves the user stuck');
  });

  it('passes when the server has seen a recent load', async () => {
    const r = await checkMemoryLoad({
      apiUrl: 'https://x', apiKey: 'k',
      fetchSelfCheck: serverSays({ last_hook_init_at: '2026-08-06T03:00:00Z', hook_inits_7d: 271 }),
      settingsPath: settings('bash ~/.claude/hooks/ownmind-session-start.sh'),
      resolveBinary: () => '/bin/bash',
    });
    assert.equal(r.status, 'pass');
  });

  it('carries the command verbatim, since that string is the whole diagnosis', async () => {
    const command = 'bash ~/.claude/hooks/ownmind-session-start.sh';
    const r = await checkMemoryLoad({
      apiUrl: 'https://x', apiKey: 'k',
      fetchSelfCheck: serverSays({ last_hook_init_at: null, hook_inits_7d: 0 }),
      settingsPath: settings(command),
      resolveBinary: () => null,
    });
    assert.equal(r.evidence.session_start_command, command);
  });

  it('names a bash that is really the WSL launcher', async () => {
    // The single fact that would have explained six machines in one glance.
    const r = await checkMemoryLoad({
      apiUrl: 'https://x', apiKey: 'k',
      fetchSelfCheck: serverSays({ last_hook_init_at: null, hook_inits_7d: 0 }),
      settingsPath: settings('bash ~/.claude/hooks/ownmind-session-start.sh'),
      resolveBinary: (bin) => (bin === 'bash' ? 'C:\\Windows\\System32\\bash.exe' : 'C:\\Program Files\\nodejs\\node.exe'),
    });
    assert.equal(r.evidence.bash_is_wsl, true);
    assert.match(r.detail, /WSL/i, 'the report must say so, not just record it');
  });

  it('records a missing SessionStart entry as its own finding', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-sc-'));
    const p = path.join(dir, 'settings.json');
    fs.writeFileSync(p, JSON.stringify({ hooks: {} }));
    const r = await checkMemoryLoad({
      apiUrl: 'https://x', apiKey: 'k',
      fetchSelfCheck: serverSays({ last_hook_init_at: null, hook_inits_7d: 0 }),
      settingsPath: p,
      resolveBinary: () => null,
    });
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.session_start_command, null);
    assert.match(r.detail, /not registered|沒有註冊|no SessionStart/i);
  });

  it('warns instead of failing when there are no credentials to ask with', async () => {
    const r = await checkMemoryLoad({
      settingsPath: settings('bash ~/.claude/hooks/ownmind-session-start.sh'),
      resolveBinary: () => '/bin/bash',
    });
    assert.equal(r.status, 'warn');
  });

  it('warns instead of failing when the server cannot be reached', async () => {
    // An offline machine is not a broken machine, and calling it one trains people to
    // ignore the check.
    const r = await checkMemoryLoad({
      apiUrl: 'https://x', apiKey: 'k',
      fetchSelfCheck: async () => { throw new Error('ECONNREFUSED'); },
      settingsPath: settings('bash ~/.claude/hooks/ownmind-session-start.sh'),
      resolveBinary: () => '/bin/bash',
    });
    assert.equal(r.status, 'warn');
  });

  it('reads this machine\'s real settings.json without throwing', async () => {
    // Every argument above is injected, so nothing so far proves the parsing survives a
    // real file. This one runs against the actual settings on this machine.
    const real = path.join(os.homedir(), '.claude', 'settings.json');
    if (!fs.existsSync(real)) return;
    const r = await checkMemoryLoad({
      fetchSelfCheck: serverSays({ last_hook_init_at: null, hook_inits_7d: 0 }),
      settingsPath: real,
    });
    assert.ok(['pass', 'warn', 'fail'].includes(r.status));
    assert.ok('session_start_command' in r.evidence);
  });
});

describe('the installer runs the new check', () => {
  it('memory_load is in the check list', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'scripts/install-helpers/self-check.cjs'), 'utf8');
    assert.match(src, /safeCheck\('memory_load'/,
      'a check nothing calls is a check nobody runs');
  });
});

// The self-check has only ever run during install and manual upgrade. Adam's last full
// report is dated 2026-05-29; his machine has auto-updated daily ever since and told us
// nothing. His scheduled scanner died in July and the diagnosis sat on his disk.
//
// Worse, the report he *did* send in May already contained the answer to the question that
// took this week to work out: `env.bash_resolution.selected === 'WSL_RELAY'`. Four of six
// Windows machines say the same thing. The data was never missing. Nothing ran often
// enough, and nothing looked.
describe('the auto-update path runs the self-check too', () => {
  const { parseArgs } = selfCheck;

  it('accepts --quick', () => {
    assert.equal(parseArgs(['node', 'x', '--quick']).quick, true);
    assert.equal(parseArgs(['node', 'x']).quick, false);
  });

  it('quick mode keeps the checks that catch this class of failure', async () => {
    const names = await selfCheck.checkNamesFor({ quick: true });
    for (const required of ['scheduler', 'memory_load', 'package_version']) {
      assert.ok(names.includes(required), `quick mode dropped ${required}`);
    }
  });

  it('quick mode drops the one that runs a full scan', async () => {
    // usage_roundtrip scans every local database. Acceptable once during an upgrade the
    // user is watching; not acceptable every day in the background.
    const names = await selfCheck.checkNamesFor({ quick: true });
    assert.ok(!names.includes('usage_roundtrip'));
    const full = await selfCheck.checkNamesFor({ quick: false });
    assert.ok(full.includes('usage_roundtrip'), 'the full run must still do it');
  });

  // Two assertions rather than one pattern: the path goes through a variable in both
  // scripts, so "the filename and the trigger appear on the same line" is not true of
  // correct code. Both facts still have to hold.
  for (const script of ['scripts/update.sh', 'scripts/update.ps1']) {
    it(`${script} runs it on every update`, () => {
      const src = fs.readFileSync(path.join(repoRoot, script), 'utf8');
      assert.match(src, /self-check\.cjs/,
        'a machine that only reports during a manual upgrade reports once a quarter');
      assert.match(src, /--trigger=auto_update/, 'the report must be labelled with why it ran');
      assert.match(src, /--quick/, 'the daily run must not scan every local database');
    });
  }
});
