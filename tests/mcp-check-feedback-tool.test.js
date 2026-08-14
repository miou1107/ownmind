import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { startServer } from './helpers/app-server.js';
import { startRealDb } from './helpers/real-db.js';

/**
 * v1.30.1 — `ownmind_report_check_feedback`, the missing half of "reply 誤判 770".
 *
 * `POST /api/compliance/feedback` shipped with the enforcement work and, until this version,
 * had no caller anywhere outside its own route test. The block notice told the user to reply
 * `誤判 <id>`; their reply reached the AI and stopped there. So every check stayed unrated, and
 * the false-positive rate — the stated threshold for switching enforcement on for anyone other
 * than the pilot user — was computed over an empty set. A notice that asks the user to do
 * something that does nothing is worse than no notice: it looks like a working feedback loop.
 *
 * Two halves are asserted here, because either alone would still leave the loop broken:
 *   1. the wiring exists in mcp/index.js (source-level, since mcp/index.js connects a stdio
 *      transport at import time and cannot be loaded in a test — the precedent
 *      tests/mcp-set-locale-tool.test.js documents), and
 *   2. the endpoint it calls really writes the verdict, against a real database.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const MCP_SOURCE = fs.readFileSync(path.join(repoRoot, 'mcp', 'index.js'), 'utf8');

function extractToolBlock(toolName) {
  const startIdx = MCP_SOURCE.indexOf(`name: "${toolName}"`);
  assert.ok(startIdx > 0, `tool "${toolName}" definition not found`);
  const rest = MCP_SOURCE.slice(startIdx);
  const nextNameIdx = rest.indexOf('\n    name: "', 5);
  const nextEndIdx = rest.indexOf('\n];');
  const endIdx = (nextNameIdx === -1 || (nextEndIdx !== -1 && nextEndIdx < nextNameIdx))
    ? nextEndIdx : nextNameIdx;
  return rest.slice(0, endIdx > 0 ? endIdx : rest.length);
}

function extractCaseBlock(toolName) {
  const startIdx = MCP_SOURCE.indexOf(`case "${toolName}":`);
  assert.ok(startIdx > 0, `case "${toolName}" handler not found`);
  const rest = MCP_SOURCE.slice(startIdx);
  const nextCaseIdx = rest.indexOf('\n    case "', 5);
  return rest.slice(0, nextCaseIdx > 0 ? nextCaseIdx : 3000);
}

describe('ownmind_report_check_feedback — tool registration', () => {
  const block = extractToolBlock('ownmind_report_check_feedback');

  it('requires both the check id and a verdict', () => {
    const required = block.match(/required:\s*\[([^\]]*)\]/);
    assert.ok(required, 'required list not found');
    assert.match(required[1], /"check_id"/);
    assert.match(required[1], /"verdict"/);
  });

  it('the verdict enum is exactly the two the server accepts', () => {
    // src/routes/compliance.js rejects anything else with 400, so a third value here would be
    // a tool that fails only once a user has already been told their report went through.
    const enumMatch = block.match(/enum:\s*\[([^\]]*)\]/);
    assert.ok(enumMatch, 'enum not found on verdict');
    const values = enumMatch[1].split(',').map((s) => s.trim().replace(/"/g, ''));
    assert.deepEqual(values.sort(), ['correct', 'false_positive']);
  });

  it('the description tells the AI that nothing is recorded without this call', () => {
    // The failure this whole change fixes was silent: the user replied and believed they had
    // reported it. An AI that treats the call as optional reproduces exactly that.
    assert.match(block, /ONLY way|nothing on its own/i);
    assert.match(block, /誤判/, 'the description must name the phrase the user is told to type');
  });

  it('the description forbids the AI rating a check on its own judgement', () => {
    assert.match(block, /Do not call it on your own judgement/i);
  });
});

describe('ownmind_report_check_feedback — handler', () => {
  const handler = extractCaseBlock('ownmind_report_check_feedback');

  it('posts to the endpoint that records the verdict', () => {
    assert.match(handler, /callApi\('POST', '\/api\/compliance\/feedback'/);
  });

  it('rejects a non-positive or non-integer check id before calling the server', () => {
    assert.match(handler, /Number\.isInteger\(checkId\)/);
    assert.match(handler, /checkId <= 0/);
  });

  it('reports a failure as a failure rather than queueing it', () => {
    // Every other write in this MCP queues on a network error. This one must not: the endpoint
    // updates one row by id, and a verdict that lands silently minutes later cannot be told
    // apart from one that never went. The user has to know to say it again.
    assert.doesNotMatch(handler, /enqueueOperation/);
    assert.match(handler, /Nothing was saved/);
  });
});

describe('the endpoint the tool calls really records the verdict', () => {
  it('writes user_feedback for the caller\'s own check and refuses another account\'s', async (t) => {
    const db = await startRealDb();
    if (!db) {
      t.skip('docker is not available on this machine, so the database seam was NOT exercised');
      return;
    }

    let server;
    let pool;
    try {
      const skipped = db.applyMigrations(path.join(repoRoot, 'db'));
      const missingCore = skipped.some((s) => /^(00[125]|025)_/.test(s));
      assert.equal(missingCore, false, `core migrations failed to apply: ${skipped.join('; ')}`);

      process.env.DB_HOST = '127.0.0.1';
      process.env.DB_PORT = String(db.port);
      process.env.DB_NAME = 'ownmind';
      process.env.DB_USER = 'ownmind';
      process.env.DB_PASSWORD = 'test';

      const complianceRoutes = (await import('../src/routes/compliance.js')).default;
      pool = (await import('../src/utils/db.js')).default ?? null;

      const app = express();
      app.use(express.json());
      app.use('/api/compliance', complianceRoutes);
      server = await startServer(app);

      db.psql(`
        INSERT INTO users (id, email, name, api_key, role) VALUES
          (1, 'fp-owner@example.com', 'Owner', 'key-fp-owner', 'user'),
          (2, 'fp-other@example.com', 'Other', 'key-fp-other', 'user')
        ON CONFLICT (id) DO NOTHING;
        SELECT setval(pg_get_serial_sequence('users','id'), 10);

        INSERT INTO compliance_checks (id, user_id, session_id, outcome)
        VALUES (770, 1, 'sess-fp', 'violation')
        ON CONFLICT (id) DO NOTHING;
        SELECT setval(pg_get_serial_sequence('compliance_checks','id'), 1000);
      `);

      const feedback = async (key, body) => {
        const res = await fetch(`${server.url}/api/compliance/feedback`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: res.status, json: await res.json().catch(() => null) };
      };
      const verdictOf = (id) => db.psql(
        `SELECT COALESCE(user_feedback, '<null>') FROM compliance_checks WHERE id = ${id};`,
      ).trim();

      assert.equal(verdictOf(770), '<null>', 'fixture starts unrated');

      const wrong = await feedback('key-fp-owner', { check_id: 770, verdict: 'meh' });
      assert.equal(wrong.status, 400, 'an invalid verdict must be refused');
      assert.equal(verdictOf(770), '<null>');

      const ok = await feedback('key-fp-owner', { check_id: 770, verdict: 'false_positive' });
      assert.equal(ok.status, 200, `expected 200, got ${ok.status}: ${JSON.stringify(ok.json)}`);
      assert.equal(verdictOf(770), 'false_positive',
        'this is the write the whole "reply 誤判 770" loop exists to produce');

      // Scoped to the caller. The UPDATE carries `AND user_id = $3`, so a colleague reporting
      // a false positive on somebody else's check changes nothing — asserted rather than
      // assumed, because a missing scope here would let one account flatten another's rate.
      const foreign = await feedback('key-fp-other', { check_id: 770, verdict: 'correct' });
      assert.equal(foreign.status, 200, 'the route reports success either way');
      assert.equal(verdictOf(770), 'false_positive',
        "another account's report must not overwrite the owner's verdict");
    } finally {
      if (server) await server.close();
      if (pool?.end) await pool.end().catch(() => {});
      db.stop();
    }
  });
});
