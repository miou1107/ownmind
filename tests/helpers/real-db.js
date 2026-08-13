import { execFileSync } from 'node:child_process';

/**
 * A real Postgres with this repo's migrations applied, for the queries that cannot be
 * proved any other way.
 *
 * `team_standard` rows are readable across accounts and their prohibition text often lives
 * in child `standard_detail` rows. Both facts are expressed only in SQL — in
 * `buildReadableWhere` and in the fragment lookup — so a test that hands a route its own
 * array of rows proves nothing about either. The compliance judge was first written with a
 * plain `WHERE user_id = $1`; measured against a real database on 2026-08-13, that query
 * cannot see a standard a colleague uploaded, which is exactly the standard the feature was
 * built to enforce. No amount of injected fixtures would have shown it.
 *
 * Returns null when docker is unavailable, so the suite still runs on a machine without it.
 * Callers must skip loudly rather than pass quietly: a database test that silently did not
 * run is the same shape of lie this whole feature exists to remove.
 */

const READY_ATTEMPTS = 40;

/**
 * @param {object}  [opts]
 * @param {string}  [opts.image]  postgres image to run
 * @param {number}  [opts.port]   host port to publish on
 * @param {string}  [opts.name]   container name, so a leftover can be replaced not duplicated
 * @returns {Promise<{name: string, port: number, psql: (sql: string) => string,
 *                    applyMigrations: (dir: string) => void, stop: () => void} | null>}
 */
export async function startRealDb({
  image = 'pgvector/pgvector:pg16',
  port = 55433,
  name = `ownmind-test-db-${port}`,
} = {}) {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
  } catch {
    return null;
  }

  try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); } catch { /* none */ }
  execFileSync('docker', ['run', '-d', '--name', name,
    '-e', 'POSTGRES_PASSWORD=test',
    '-e', 'POSTGRES_USER=ownmind',
    '-e', 'POSTGRES_DB=ownmind',
    '-p', `${port}:5432`,
    image], { stdio: 'ignore' });

  let ready = false;
  for (let i = 0; i < READY_ATTEMPTS; i += 1) {
    try {
      execFileSync('docker', ['exec', name, 'pg_isready', '-U', 'ownmind', '-d', 'ownmind'],
        { stdio: 'ignore' });
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => { setTimeout(resolve, 1000); });
    }
  }
  const stop = () => {
    try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); } catch { /* gone */ }
  };
  if (!ready) {
    stop();
    throw new Error(`postgres container ${name} never became ready`);
  }

  /** Run SQL and return stdout. Throws on error, so a broken fixture fails the test. */
  const psql = (sql) => execFileSync(
    'docker',
    ['exec', '-i', name, 'psql', '-U', 'ownmind', '-d', 'ownmind', '-v', 'ON_ERROR_STOP=1', '-tA'],
    { input: sql, encoding: 'utf8' },
  );

  /**
   * Apply every db/NNN_*.sql in order.
   *
   * A migration that fails is reported, not swallowed: some of this repo's migrations assume
   * data that a blank database does not have, and the difference between "did not apply
   * because it was irrelevant" and "did not apply because it is broken" is one a caller has
   * to be able to see.
   */
  const applyMigrations = (dir) => {
    const files = execFileSync('ls', [dir], { encoding: 'utf8' })
      .split('\n')
      .filter((f) => /^\d+_.*\.sql$/.test(f))
      .sort();
    const skipped = [];
    for (const file of files) {
      try {
        execFileSync(
          'docker',
          ['exec', '-i', name, 'psql', '-U', 'ownmind', '-d', 'ownmind', '-v', 'ON_ERROR_STOP=1', '-q'],
          { input: execFileSync('cat', [`${dir}/${file}`], { encoding: 'utf8' }), encoding: 'utf8' },
        );
      } catch (err) {
        skipped.push(`${file}: ${String(err.stderr || err.message).split('\n')[0]}`);
      }
    }
    return skipped;
  };

  return { name, port, psql, applyMigrations, stop };
}
