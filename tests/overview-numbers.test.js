// v1.32.8 — the numbers on 總覽 say what they count.
//
// Measured 2026-10-08 on the owner's account, the first day the rebuilt console was live:
//   - 「你的 AI 對話 215 場」 in 7 days, 204 of them on one day. The tile counted init events,
//     and the SessionStart hook fires on startup, resume, clear and compact — so one long
//     conversation compacted three times read as four.
//   - 「20 份交接等你接手」 when 67 were pending: the sentence used the length of a list
//     capped at 20.
//   - 用量回報 yellow, naming twenty "tools" — ownmind_search, ownmind_init, scanner, server:
//     activity_logs.tool holds the MCP function name on mcp_call rows, not an AI tool.
//   - 「你最常做的專案」 was the one with the most turns (3 sessions), not the most sessions (25).
//   - 最後一次活動 named the MCP function (ownmind_get_secret) as "the tool".
// These tests pin the fixes, at the query text and through the view-model. The home redesign
// later removed the sessions, project and last-activity tiles; what is left of each fix is here.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execBashScript, toBashPath as bp } from './helpers/bash-script.js';
import { tempDir } from './helpers/temp-dir.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { buildOverview } = await import('../src/routes/me-overview.js');
const zh = JSON.parse(fs.readFileSync(path.join(repoRoot, 'client/src/i18n/zh.json'), 'utf8'));
const t = (k) => zh[k] ?? k;

function fakeQuery(answers) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    for (const [needle, rows] of answers) if (sql.includes(needle)) return { rows };
    return { rows: [] };
  };
  return { query, calls };
}

// Sixty-seven handoffs waiting.
const answers = [
  ['AS n FROM handoffs', [{ n: 67 }]],
  ['AS n FROM session_lessons', [{ n: 49 }]],
  ['AS n FROM tasks', [{ n: 1 }]],
  ['AS n FROM bug_reports', [{ n: 3 }]],
  ["event = 'iron_rule_compliance'", [
    { rule_code: null, current: true, comply: 0, skip: 0, violate: 2, observed: 0 },
    { rule_code: 'IR-004', current: true, comply: 40, skip: 0, violate: 1, observed: 0 },
  ]],
  ['FROM memories', [{ code: 'IR-004', title: '回我話要用白話中文' }]],
];
const user = { id: 7, role: 'user' };
const admin = { id: 1, role: 'admin' };
const NOW = new Date('2026-10-08T03:00:00Z');

describe('v1.32.8 — the overview uses the real counts, not a capped preview', () => {
  it('what 要你決定的事 leaves off is the real count minus the recent ones', async () => {
    const { query } = fakeQuery(answers);
    const o = await buildOverview({ query, user: admin, rangeDays: 7, canonicalHost: null, now: NOW });
    // 67 + 49 + 1 + 3 waiting; nothing recent in this fixture.
    assert.equal(o.decisions.hidden, 120);
  });

  it('a member\'s total leaves bugs out', async () => {
    const { query } = fakeQuery(answers);
    const o = await buildOverview({ query, user, rangeDays: 7, canonicalHost: null, now: NOW });
    assert.equal(o.decisions.hidden, 117);
  });
});

describe('v1.32.8 — one conversation is counted once', () => {
  it('the team table collapses rows that share a session id', async () => {
    const { query, calls } = fakeQuery(answers);
    await buildOverview({ query, user: admin, rangeDays: 7, canonicalHost: null, now: NOW });
    const sql = calls.find((c) => c.sql.includes('AS last_active_at')).sql;
    assert.match(sql, /COUNT\(DISTINCT COALESCE\(a\.details->>'session_id', a\.id::text\)\)/);
  });

  it('用量 › 我的對話 counts the same way', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'src/routes/me.js'), 'utf8');
    assert.match(src, /COUNT\(DISTINCT COALESCE\(details->>'session_id', id::text\)\) FILTER \(WHERE event = 'init'\) AS sessions/);
  });
});

describe('v1.32.8 — an MCP function name is not a tool', () => {
  const sqlOf = (calls, needle) => calls.find((c) => c.sql.includes(needle))?.sql;

  it('the silent-collector check skips ownmind_* and the two services', async () => {
    const { query, calls } = fakeQuery(answers);
    await buildOverview({ query, user, rangeDays: 7, canonicalHost: null, now: NOW });
    const sql = sqlOf(calls, 'LEFT JOIN hb ON');
    assert.match(sql, /tool NOT LIKE 'ownmind\\_%'/);
    assert.match(sql, /tool NOT IN \('scanner', 'server'\)/);
    // The LIKE pattern escapes the underscore: 'ownmind_%' alone would also match
    // 'ownmindX…', and more to the point reads as "any one character".
    assert.match(sql, /ownmind\\_%/);
  });

  it('the report\'s own silent-collector audit skips them too', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'src/routes/me.js'), 'utf8');
    const audit = src.slice(src.indexOf('heartbeatAuditQ'), src.indexOf('consistencyQ'));
    assert.match(audit, /tool NOT LIKE 'ownmind\\\\_%' AND tool NOT IN \('scanner', 'server'\)/);
  });
});

describe('v1.32.8 — a miss without a rule code', () => {
  it('cannot be named as a rule AI forgets, but still counts against the rate', async () => {
    const { query } = fakeQuery(answers);
    const o = await buildOverview({ query, user, rangeDays: 7, canonicalHost: null, now: NOW });
    assert.deepEqual(o.rules.top_missed.map((r) => r.code), ['IR-004']);
    assert.equal(o.rules.top_missed[0].title, '回我話要用白話中文');
    // 40 / 43.
    assert.ok(Math.abs(o.rules.rate - 40 / 43) < 1e-9);
  });
});

describe('v1.32.8 — the init event carries the session id', () => {
  it('the Node hook puts session_id and start_source on the init it reports', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'hooks/ownmind-session-start.js'), 'utf8');
    assert.match(src, /reportEvent\(apiUrl, apiKey, 'init', \{ status: 'ok', \.\.\.sessionFieldsOf\(readHookPayload\(\)\) \}\)/);
    // stdin is read once and shared: the gate provisioning and the init both need it.
    assert.equal((src.match(/fs\.readFileSync\(0, 'utf8'\)/g) || []).length, 1);
    assert.match(src, /\^\[A-Za-z0-9._-\]\{1,128\}\$/, 'the id is whitelisted');
    assert.match(src, /\^\(startup\|resume\|clear\|compact\)\$/, 'the source is one of four');
  });

  it('the shell hook writes the pair when it has one and nothing when it does not', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'hooks/ownmind-session-start.sh'), 'utf8');
    const fnStart = src.indexOf('log_event() {');
    const fn = src.slice(fnStart, src.indexOf('\n}\n', fnStart) + 3);
    const initLine = src.split('\n').find((l) => l.startsWith('log_event "init" "status" "ok"'));
    assert.ok(initLine, 'the init line is gone');
    assert.match(initLine, /\$\{HOOK_SESSION_ID:\+"session_id" "\$HOOK_SESSION_ID"\}/);
    assert.match(initLine, /\$\{HOOK_START_SOURCE:\+"start_source" "\$HOOK_START_SOURCE"\}/);

    const run = (vars) => {
      const home = tempDir('ownmind-init-');
      try {
        execBashScript([
          `OWNMIND_DIR=${JSON.stringify(bp(path.join(home, '.ownmind')))}`,
          'LOG_DIR="$OWNMIND_DIR/logs"',
          'API_KEY=""; API_URL=""; OWNMIND_PROJECT_NAME=""',
          'unset CLAUDE_PROJECT_DIR',
          vars,
          fn,
          initLine,
        ].join('\n'), { env: { ...process.env, HOME: bp(home) }, stdio: ['ignore', 'ignore', 'ignore'] });
        const logDir = path.join(home, '.ownmind', 'logs');
        const file = fs.readdirSync(logDir).find((f) => f.endsWith('.jsonl'));
        return JSON.parse(fs.readFileSync(path.join(logDir, file), 'utf8').trim().split('\n').pop()).details;
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    };
    const withId = run('HOOK_SESSION_ID="abc-123.def"; HOOK_START_SOURCE="compact"');
    assert.equal(withId.status, 'ok');
    assert.equal(withId.session_id, 'abc-123.def');
    assert.equal(withId.start_source, 'compact');
    const without = run('HOOK_SESSION_ID=""; HOOK_START_SOURCE=""');
    assert.equal(without.status, 'ok');
    assert.equal('session_id' in without, false);
    assert.equal('start_source' in without, false);
  });
});
