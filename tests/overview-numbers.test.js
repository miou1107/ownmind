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
// These tests pin the fixes, at the query text and through the view-model.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execBashScript, toBashPath as bp } from './helpers/bash-script.js';
import { tempDir } from './helpers/temp-dir.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { buildOverview } = await import('../src/routes/me-overview.js');
const { pendingVm } = await import('../client/src/pages/Home/overview-vm.js');
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

// Twenty pending handoffs in the preview, sixty-seven in the count.
const preview = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, project: 'idaytour', from_tool: 'codex', from_machine: null, created_at: '2026-10-08T01:00:00Z' }));
const answers = [
  ['AS n FROM handoffs', [{ n: 67 }]],
  ['AS n FROM session_lessons', [{ n: 49 }]],
  ['AS n FROM tasks', [{ n: 1 }]],
  ['AS n FROM bug_reports', [{ n: 3 }]],
  ['SELECT id, project, from_tool', preview],
  ["event = 'iron_rule_compliance'", [
    { rule_code: null, current: true, comply: 0, skip: 0, violate: 2, observed: 0 },
    { rule_code: 'IR-004', current: true, comply: 40, skip: 0, violate: 1, observed: 0 },
  ]],
  ["FROM memories WHERE type = 'iron_rule'", [{ title: '回我話要用白話中文' }]],
];
const user = { id: 7, role: 'user' };
const admin = { id: 1, role: 'admin' };
const NOW = new Date('2026-10-08T03:00:00Z');

describe('v1.32.8 — 等你處理 says how many really wait', () => {
  it('the overview carries the inbox counts next to the capped previews', async () => {
    const { query } = fakeQuery(answers);
    const o = await buildOverview({ query, user: admin, rangeDays: 7, canonicalHost: null, now: NOW });
    assert.equal(o.pending.handoffs.length, 20, 'the preview stays capped');
    assert.deepEqual(o.pending.counts, { handoffs: 67, lessons: 49, tasks: 1, bugs: 3, total: 120 });
  });

  it('a member gets no bug count, and the total leaves bugs out', async () => {
    const { query } = fakeQuery(answers);
    const o = await buildOverview({ query, user, rangeDays: 7, canonicalHost: null, now: NOW });
    assert.equal(o.pending.counts.bugs, null);
    assert.equal(o.pending.counts.total, 117);
  });

  it('the sentence uses the count, not the preview length', async () => {
    const { query } = fakeQuery(answers);
    const o = await buildOverview({ query, user, rangeDays: 7, canonicalHost: null, now: NOW });
    const rows = pendingVm(o, t);
    assert.equal(rows.find((r) => r.id === 'handoffs').text, '67 份交接等你接手');
    assert.equal(rows.find((r) => r.id === 'lessons').text, '49 條學到的，等你決定留不留');
  });

  it('without counts (an older server) the sentence falls back to the list length', () => {
    const rows = pendingVm({ pending: { handoffs: preview.slice(0, 3), lessons: [], tasks: [], bugs: null } }, t);
    assert.equal(rows[0].text, '3 份交接等你接手');
  });

  it('a count of zero with an empty list shows nothing', () => {
    const rows = pendingVm({ pending: { counts: { handoffs: 0, lessons: 0, tasks: 0, bugs: null, total: 0 }, handoffs: [], lessons: [], tasks: [], bugs: null } }, t);
    assert.deepEqual(rows, []);
  });
});

describe('v1.32.8 — one conversation is counted once', () => {
  const sqlOf = (calls, needle) => calls.find((c) => c.sql.includes(needle))?.sql;

  it('the sessions tile and the daily chart collapse rows that share a session id', async () => {
    const { query, calls } = fakeQuery(answers);
    await buildOverview({ query, user, rangeDays: 7, canonicalHost: null, now: NOW });
    const tile = sqlOf(calls, 'AS previous');
    assert.match(tile, /COUNT\(DISTINCT COALESCE\(details->>'session_id', id::text\)\) FILTER \(WHERE ts >= NOW\(\)/);
    const daily = sqlOf(calls, 'generate_series');
    assert.match(daily, /COUNT\(DISTINCT COALESCE\(a\.details->>'session_id', a\.id::text\)\)/);
    assert.ok(!/COUNT\(\*\) FILTER \(WHERE ts >= NOW\(\) - INTERVAL '7 days'\)::int AS current/.test(tile), 'the old count-every-init is gone');
  });

  it('用量 › 我的對話 counts the same way', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'src/routes/me.js'), 'utf8');
    assert.match(src, /COUNT\(DISTINCT COALESCE\(details->>'session_id', id::text\)\) FILTER \(WHERE event = 'init'\) AS sessions/);
  });
});

describe('v1.32.8 — an MCP function name is not a tool', () => {
  const sqlOf = (calls, needle) => calls.find((c) => c.sql.includes(needle))?.sql;

  it('the silent-collector check and 最後一次活動 skip ownmind_* and the two services', async () => {
    const { query, calls } = fakeQuery(answers);
    await buildOverview({ query, user, rangeDays: 7, canonicalHost: null, now: NOW });
    for (const needle of ['LEFT JOIN hb ON', 'ORDER BY ts DESC']) {
      const sql = sqlOf(calls, needle);
      assert.match(sql, /tool NOT LIKE 'ownmind\\_%'/, needle);
      assert.match(sql, /tool NOT IN \('scanner', 'server'\)/, needle);
    }
    // The LIKE pattern escapes the underscore: 'ownmind_%' alone would also match
    // 'ownmindX…', and more to the point reads as "any one character".
    assert.match(sqlOf(calls, 'LEFT JOIN hb ON'), /ownmind\\_%/);
  });

  it('the report\'s own silent-collector audit skips them too', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'src/routes/me.js'), 'utf8');
    const audit = src.slice(src.indexOf('heartbeatAuditQ'), src.indexOf('consistencyQ'));
    assert.match(audit, /tool NOT LIKE 'ownmind\\\\_%' AND tool NOT IN \('scanner', 'server'\)/);
  });
});

describe('v1.32.8 — the tiles say what their label says', () => {
  it('最常做的專案 is the one with the most sessions', async () => {
    const { query, calls } = fakeQuery(answers);
    await buildOverview({ query, user, rangeDays: 7, canonicalHost: null, now: NOW });
    const sql = calls.find((c) => c.sql.includes('WITH p AS')).sql;
    assert.match(sql, /ORDER BY sessions DESC, turns DESC NULLS LAST\s+LIMIT 1/);
  });

  it('a violation reported without a rule code cannot be "the worst rule"', async () => {
    const { query } = fakeQuery(answers);
    const o = await buildOverview({ query, user, rangeDays: 7, canonicalHost: null, now: NOW });
    assert.equal(o.tiles.compliance.worst_rule.code, 'IR-004');
    assert.equal(o.tiles.compliance.worst_rule.title, '回我話要用白話中文');
    // …but it still counts against the rate: 40 / 43.
    assert.ok(Math.abs(o.tiles.compliance.rate - 40 / 43) < 1e-9);
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
