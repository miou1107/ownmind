import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './helpers/app-server.js';
import { startRealDb } from './helpers/real-db.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The bundle endpoint, reached through the real router and answered by a real database.
 *
 * Two things can only be proved here, and both of them were wrong in the first draft of this
 * feature while every unit test passed:
 *
 *  1. Routing. `/api/memory/:id` lives in the same router. Registered after it, this endpoint
 *     is handed its own name as an id, the integer cast fails, and the client gets a 500 it
 *     can only read as "the server is unavailable" - so the cache never fills and nothing
 *     says why.
 *
 *  2. Visibility. Team standards are readable across accounts, and the standard this feature
 *     exists to enforce belongs to a colleague. Measured against a real database: a plain
 *     `WHERE user_id = $1` cannot see it. Any test that hands the route its own rows agrees
 *     with whatever the route asked for and proves nothing about which rows exist.
 *
 * The fixture is the 2026-08-13 incident's own shape: standard 412 uploaded by user 2, its
 * prohibition list in a child fragment, and user 1 doing the asking.
 */

const FIXTURE_SQL = `
INSERT INTO users (id, email, name, api_key, role) VALUES
  (1, 'caller@example.com', 'Caller', 'key-caller', 'admin'),
  (2, 'colleague@example.com', 'Colleague', 'key-colleague', 'admin')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('users','id'), 10);

INSERT INTO memories (id, user_id, type, title, content, tags, metadata, status) VALUES
  (412, 2, 'team_standard',
   'ci ownership belongs to the colleague',
   'This standard governs who may change the CI configuration.',
   ARRAY['trigger:ci'],
   '{"enforcement":{"keywords":["FAPA"],"guard":{"repo_match":"shared-monorepo","paths":["ci/**"],"owner":"Colleague"}}}'::jsonb,
   'active'),
  (413, 2, 'standard_detail',
   'ci ownership > forbidden list',
   'NEVER edit ci/projects.yml. No engineer including admins may.',
   ARRAY['rule_detail'],
   '{"parent_id":"412","level":2}'::jsonb,
   'active'),
  (125, 1, 'iron_rule',
   'a rule the caller owns',
   'Talk conclusion-first.',
   ARRAY['trigger:always'],
   '{"enforcement":{"always_check":true}}'::jsonb,
   'active')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('memories','id'), 1000);
`;

test('the mounted endpoint returns a colleague-owned standard from a real database', async (t) => {
  const db = await startRealDb({ port: 55434, name: 'ownmind-test-bundle-db' });
  if (!db) {
    // Loud, not silent. A database test that quietly did not run is the same shape of lie
    // this feature exists to remove.
    t.skip('docker is not available on this machine, so the database seam was NOT exercised');
    return;
  }

  let server;
  let pool;
  try {
    const skipped = db.applyMigrations(path.join(repoRoot, 'db'));
    const missingCore = skipped.some((s) => /^00[12]_/.test(s));
    assert.equal(missingCore, false, `core migrations failed to apply: ${skipped.join('; ')}`);
    db.psql(FIXTURE_SQL);

    // The pool in src/utils/db.js reads these at module load, so they have to be set before
    // the first import of anything that pulls it in.
    process.env.DB_HOST = '127.0.0.1';
    process.env.DB_PORT = String(db.port);
    process.env.DB_NAME = 'ownmind';
    process.env.DB_USER = 'ownmind';
    process.env.DB_PASSWORD = 'test';

    const memoryRoutes = (await import('../src/routes/memory.js')).default;
    pool = (await import('../src/utils/db.js')).default ?? null;

    const app = express();
    app.use(express.json());
    // No fake user is injected. The router installs the real `auth` middleware, so the
    // request carries a real key belonging to a real row - which also means this test
    // covers the auth seam the client has to satisfy in production.
    app.use('/api/memory', memoryRoutes);

    server = await startServer(app);
    const res = await fetch(`${server.url}/api/memory/enforcement-bundle`, {
      headers: { Authorization: 'Bearer key-caller' },
    });
    assert.equal(
      res.status, 200,
      'a 500 means GET /:id matched first and tried to read "enforcement-bundle" as an id',
    );
    const body = await res.json();

    const ids = body.selectors.map((s) => s.id).sort((a, b) => a - b);
    assert.ok(
      ids.includes(412),
      'standard 412 belongs to another account; an owner-scoped query would omit it, '
      + 'and it is the exact standard this feature exists to enforce',
    );
    assert.ok(ids.includes(125), 'the caller\'s own rule must still come back');
    assert.deepEqual(body.guards.map((g) => g.id), [412]);
    assert.equal(body.guards[0].owner, 'Colleague');

    // The counter-proof: the query the first draft wrote cannot see it. Without this, a
    // passing test above could mean the visibility rule works or that nothing filters at all.
    const ownerScoped = db.psql(
      "SELECT count(*) FROM memories m WHERE m.status='active' AND m.user_id=1 "
      + "AND m.type IN ('iron_rule','team_standard','principle','coding_standard');",
    ).trim();
    assert.equal(ownerScoped, '1', 'an owner-scoped query should see only the caller\'s own rule');
  } finally {
    if (server) await server.close();
    if (pool?.end) await pool.end().catch(() => {});
    db.stop();
  }
});
