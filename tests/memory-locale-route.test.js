import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './helpers/app-server.js';
import { startRealDb } from './helpers/real-db.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Task 5 (gate-message-i18n): account language preference, `PUT /api/memory/locale`
 * and its echo through `GET /api/memory/init`, against a real database.
 *
 * Two things only a real Postgres proves here:
 *
 *  1. The write itself. `jsonb_set(COALESCE(settings, '{}'::jsonb), '{locale}', ...)` and
 *     the key-delete for `auto` are SQL, not JS — a fixture-driven unit test that hands the
 *     route a canned `settings` object would agree with whatever the route asked for and
 *     prove nothing about whether the SQL actually mutates the column, or survives a row
 *     whose `settings` is SQL NULL rather than `'{}'`.
 *
 *  2. The round trip. `hooks/lib/locale.js` (Task 2) reads `cache.data.locale`, which
 *     `runConditionalSync` persists verbatim from whatever `GET /api/memory/init` returns.
 *     Only hitting both endpoints against the same row proves the value PUT wrote is the
 *     value init echoes back — a mock could get either side wrong independently.
 */

test('account locale preference: set, echoed via init, auto clears, invalid input rejected', async (t) => {
  const db = await startRealDb();
  if (!db) {
    t.skip('docker is not available on this machine, so the database seam was NOT exercised');
    return;
  }

  let server;
  let pool;
  try {
    const skipped = db.applyMigrations(path.join(repoRoot, 'db'));
    const missingCore = skipped.some((s) => /^00[12]_/.test(s));
    assert.equal(missingCore, false, `core migrations failed to apply: ${skipped.join('; ')}`);

    // The pool in src/utils/db.js reads these at module load, so they must be set before the
    // first import of anything that pulls it in (same constraint enforcement-bundle-mounted
    // documented).
    process.env.DB_HOST = '127.0.0.1';
    process.env.DB_PORT = String(db.port);
    process.env.DB_NAME = 'ownmind';
    process.env.DB_USER = 'ownmind';
    process.env.DB_PASSWORD = 'test';

    const memoryRoutes = (await import('../src/routes/memory.js')).default;
    pool = (await import('../src/utils/db.js')).default ?? null;

    const app = express();
    app.use(express.json());
    // No fake user is injected — the router installs the real `auth` middleware, so every
    // request below carries a real Authorization header for a real row, exercising the same
    // auth seam production traffic goes through.
    app.use('/api/memory', memoryRoutes);

    server = await startServer(app);

    db.psql(`
      INSERT INTO users (id, email, name, api_key, role, settings) VALUES
        (1, 'locale-a@example.com', 'Locale A', 'key-locale-a', 'user', '{}'::jsonb),
        (2, 'locale-b@example.com', 'Locale B', 'key-locale-b', 'user', NULL),
        (3, 'locale-c@example.com', 'Locale C', 'key-locale-c', 'user',
          '{"onboarding_completed_at":"2026-01-01T00:00:00Z","locale":"zh"}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
      SELECT setval(pg_get_serial_sequence('users','id'), 10);
    `);

    // Reads the body exactly once (a fetch Response can only be consumed once), so callers
    // can freely reference `.json` in a failure message without the "body already read"
    // error that comes from a second `.text()`/`.json()` call on the same response.
    const put = async (apiKey, body) => {
      const res = await fetch(`${server.url}/api/memory/locale`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    const initFor = async (apiKey) => {
      const res = await fetch(`${server.url}/api/memory/init?compact=true`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    const storedLocale = (apiKey) => db.psql(
      `SELECT settings->>'locale' FROM users WHERE api_key = '${apiKey}';`,
    ).trim();
    const hasLocaleKey = (apiKey) => db.psql(
      `SELECT (COALESCE(settings,'{}'::jsonb) ? 'locale') FROM users WHERE api_key = '${apiKey}';`,
    ).trim();

    // --- 1. Setting a valid locale writes settings.locale via jsonb_set, even from a row
    //     whose settings column is SQL NULL (user 2), exercising the COALESCE branch. ---
    {
      const { status, json } = await put('key-locale-b', { locale: 'ja' });
      assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(json)}`);
      assert.equal(json.locale, 'ja');
      assert.equal(storedLocale('key-locale-b'), 'ja');
    }

    // --- 2. GET /init echoes the value the write just persisted, proving the two ends of
    //     the contract hooks/lib/locale.js depends on actually agree. ---
    {
      const { status, json } = await initFor('key-locale-b');
      assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(json)}`);
      assert.equal(json.locale, 'ja');
    }

    // --- 3. `auto` deletes the settings key outright (not just sets it to null / 'auto'),
    //     so `cache.data.locale` is absent and OS detection wins client-side. ---
    {
      const { status, json } = await put('key-locale-c', { locale: 'auto' });
      assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(json)}`);
      assert.equal(hasLocaleKey('key-locale-c'), 'f', 'settings must no longer contain the locale key');
      // The sibling onboarding_completed_at key must survive untouched — the delete must be
      // scoped to the locale key alone, not a settings wipe.
      const onboarding = db.psql(
        `SELECT settings->>'onboarding_completed_at' FROM users WHERE api_key = 'key-locale-c';`,
      ).trim();
      assert.equal(onboarding, '2026-01-01T00:00:00Z');
    }

    // --- 4. After auto, init must not echo the old value back (omitted or null; the client
    //     tolerates absence, so this checks against re-appearing, not against a specific shape). ---
    {
      const { status, json } = await initFor('key-locale-c');
      assert.equal(status, 200);
      assert.ok(json.locale === null || json.locale === undefined,
        `expected locale to be cleared (null/undefined), got ${JSON.stringify(json.locale)}`);
    }

    // --- 5. A never-set account (user 1, settings = '{}') reports no locale via init. ---
    {
      const { status, json } = await initFor('key-locale-a');
      assert.equal(status, 200);
      assert.ok(json.locale === null || json.locale === undefined,
        `an account that never set a preference must not report one, got ${JSON.stringify(json.locale)}`);
    }

    // --- 6. Invalid locale values are rejected with 4xx and never reach the database. ---
    for (const bad of ['fr', 'ZH', 'zh-TW', '', 123, null]) {
      const { status } = await put('key-locale-a', { locale: bad });
      assert.ok(status >= 400 && status < 500,
        `locale=${JSON.stringify(bad)} should be rejected with 4xx, got ${status}`);
      assert.equal(storedLocale('key-locale-a'), '',
        `an invalid write must not touch settings.locale (value: ${JSON.stringify(bad)})`);
    }

    // --- 7. A missing `locale` field is rejected the same way. ---
    {
      const { status } = await put('key-locale-a', {});
      assert.ok(status >= 400 && status < 500, `missing locale should be rejected, got ${status}`);
    }

    // --- 8. The write path sits behind real auth: no Authorization header → 401, no write. ---
    {
      const res = await fetch(`${server.url}/api/memory/locale`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale: 'en' }),
      });
      assert.equal(res.status, 401);
    }
  } finally {
    if (server) await server.close();
    if (pool?.end) await pool.end().catch(() => {});
    db.stop();
  }
});
