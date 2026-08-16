/**
 * `pending` against a real database, because the stub cannot tell you it is illegal.
 *
 * `tests/compliance-select-only.test.js` proves the route answers correctly. It stubs
 * `queryFn`, so it would go on passing if the value the route inserts were one the schema
 * rejects — and it was: `compliance_checks_outcome_check` allowed exactly
 * `clean | violation | skipped | failed` until `db/026`. Every select-only request would have
 * thrown on the INSERT in production, been swallowed by `record`'s catch, and returned
 * `check_id: null` to a client that then had nowhere to send its verdict.
 *
 * A green suite over a broken production path is the failure this project keeps having. This
 * is the test that has the constraint in it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRealDb } from './helpers/real-db.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a check can be recorded as pending, and the migration is what allows it', async (t) => {
  const db = await startRealDb();
  if (!db) {
    // Loud, not silent — a database test that quietly did not run is the same shape of lie
    // the rest of this release is about.
    t.skip('docker is not available on this machine, so the schema was NOT exercised');
    return;
  }

  try {
    const skipped = db.applyMigrations(path.join(repoRoot, 'db'));
    assert.equal(skipped.some((s) => /^02[56]_/.test(s)), false,
      `the migrations under test failed to apply: ${skipped.join('; ')}`);

    // psql prints the RETURNING row and then the command tag ("INSERT 0 1"); the value is the
    // first line. Feeding the whole thing into the next statement produced a syntax error
    // that read as a broken migration.
    const first = (out) => String(out).trim().split('\n')[0].trim();

    const userId = first(db.psql(
      `INSERT INTO users (email, password_hash, api_key)
       VALUES ('pending-outcome@example.com', 'x', 'k-pending-outcome') RETURNING id;`,
    ));
    assert.match(userId, /^\d+$/, 'needed a user to hang the checks off');

    const insert = (outcome) => first(db.psql(
      `INSERT INTO compliance_checks (user_id, session_id, rules_considered, verdicts, outcome)
       VALUES (${userId}, 's1', '{"judged":[]}'::jsonb, '[]'::jsonb, '${outcome}')
       RETURNING outcome;`,
    ));

    assert.equal(insert('pending'), 'pending', 'the state the select-only path opens a row in');

    // The four that were always allowed still are — a migration that widens a constraint by
    // dropping and recreating it can just as easily narrow it.
    for (const outcome of ['clean', 'violation', 'skipped', 'failed']) {
      assert.equal(insert(outcome), outcome);
    }

    // And it is still a constraint, not a free-text column.
    assert.throws(
      () => insert('whatever'),
      (err) => {
        assert.match(`${err.message}${err.stderr || ''}`, /violates check constraint/);
        return true;
      },
      'widening the set must not have turned it off',
    );

    // The partial index the client's per-turn lookup depends on.
    const idx = db.psql(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'compliance_checks'
        AND indexname = 'idx_compliance_checks_pending';`,
    ).trim();
    assert.equal(idx, 'idx_compliance_checks_pending',
      'the pending lookup runs on every turn; it cannot be a scan');
  } finally {
    await db.stop();
  }
});
