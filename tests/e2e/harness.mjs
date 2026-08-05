// Bring up a throwaway OwnMind stack for the end-to-end suite, and tear it down after.
//
// Why a scratch stack rather than the dev one: the suite creates users with known
// passwords and three different roles. Doing that in a database that holds real memories
// would leave test accounts behind, and the project rule is to clean up after testing.
// A container with no volume disappears entirely when it stops.
//
// The API is started as a child process rather than in Docker, so a code change is picked
// up without an image rebuild. It serves the client build from src/public/dashboard, which
// is what the browser drives.

import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import bcrypt from 'bcrypt';
import pg from 'pg';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const DB_CONTAINER = 'ownmind-e2e-db';
const DB_NAME = 'ownmind_e2e';
const DB_USER = 'ownmind';

// The database password and the server's encryption key are generated per run and never
// written to disk. They only have to be known by this process, which is both the thing that
// starts the container and the thing that connects to it. Nothing secret-looking ends up in
// the repository, so there is no judgement call about whether a committed literal counts.
const scratchSecret = () => randomBytes(24).toString('hex');

// The account passwords below are different: the specs run in a separate worker process and
// import them from here, so they cannot be random per process. They are fixtures for
// throwaway accounts in a database that is destroyed when the run ends.

/** Accounts the specs log in as. `must_change_password` false so the password guard is out of the way. */
export const ACCOUNTS = {
  user: { email: 'e2e-user@example.com', name: 'E2E User', role: 'user', password: 'e2e-pass-user' },
  admin: { email: 'e2e-admin@example.com', name: 'E2E Admin', role: 'admin', password: 'e2e-pass-admin' },
  superAdmin: {
    email: 'e2e-super@example.com', name: 'E2E Super', role: 'super_admin', password: 'e2e-pass-super',
  },
};

/**
 * The state scripts/reset-admin-password.js leaves behind: a super_admin whose
 * password_hash is NULL. Seeded separately from ACCOUNTS because nothing can log in as
 * it — it exists so the sole-admin recovery path can be driven end to end, which
 * v1.26.59 needs because retiring /admin/ removed the only UI that used to finish it.
 */
export const LOCKED_SUPER_ADMIN = {
  email: 'e2e-locked@example.com', name: 'E2E Locked', role: 'super_admin',
};

/** Matches SETUP_TOKEN in the API environment below. A throwaway stack, not a secret. */
export const E2E_SETUP_TOKEN = 'e2e-setup-token';

/**
 * Everyone `seedAccounts` creates. Derived rather than written out, so adding a fixture
 * account does not silently falsify a denominator a spec asserts. It is still a real
 * assertion: a page that miscounts the team fails against it.
 */
export const SEEDED_USER_COUNT = Object.keys(ACCOUNTS).length + 1;

function docker(args, opts = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', ...opts });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(label, probe, { tries = 90, gap = 1000 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await probe()) return;
    // eslint-disable-next-line no-await-in-loop
    await sleep(gap);
  }
  throw new Error(`e2e harness: timed out waiting for ${label}`);
}

async function startDatabase(dbPassword) {
  // Remove a leftover from an interrupted run before claiming the name.
  try { docker(['rm', '-f', DB_CONTAINER], { stdio: 'ignore' }); } catch { /* not there */ }

  const port = await freePort();
  docker([
    'run', '--rm', '-d',
    '--name', DB_CONTAINER,
    '-e', `POSTGRES_DB=${DB_NAME}`,
    '-e', `POSTGRES_USER=${DB_USER}`,
    '-e', `POSTGRES_PASSWORD=${dbPassword}`,
    '-p', `127.0.0.1:${port}:5432`,
    // pgvector, not plain postgres: the migrations create a vector extension.
    'pgvector/pgvector:pg16',
  ], { stdio: 'pipe' });

  await waitFor('postgres to accept connections', async () => {
    try {
      // psql inside the container, so the check does not depend on a local client.
      docker(['exec', DB_CONTAINER, 'psql', '-U', DB_USER, '-d', DB_NAME, '-c', 'SELECT 1'],
        { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  });

  return port;
}

async function startApi(dbPort, dbPassword, encryptionKey) {
  const port = await freePort();
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      // dotenv does not override variables already present, so these win over .env.
      PORT: String(port),
      DB_HOST: '127.0.0.1',
      DB_PORT: String(dbPort),
      DB_NAME,
      DB_USER,
      DB_PASSWORD: dbPassword,
      // 32+ chars, required or the server refuses to boot. Generated per run.
      ENCRYPTION_KEY: encryptionKey,
      // Deliberately unset so /api/me/narrative/insights answers 503 no_api_key, which is
      // the degradation one of the specs asserts.
      LLM_SWITCH_API_KEY: '',
      OWNMIND_LLM_API_BASE: '',
      // v1.26.59: set so the sole-admin recovery path can be driven end to end. It
      // changes nothing for accounts that have a password — the token only unlocks
      // POST /api/admin/setup, and the requiresSetup signal is limited to a
      // super_admin whose password_hash is NULL. See src/utils/setup-recovery.js.
      SETUP_TOKEN: E2E_SETUP_TOKEN,
      // The suite is one browser walking every page of the console inside a
      // single rate-limit window, so the shipped ceiling of 200 per minute is
      // reached partway through and the remaining specs fail at login with a
      // 429 that looks like a bug in whatever they were testing.
      API_RATE_LIMIT_MAX: '5000',
      // v1.26.60: /api/me/login gained the brute-force limiter (10 per 15 minutes),
      // which every spec would hit — nearly all of them log in. Raised for the same
      // reason and in the same way as the ceiling above; absent leaves the shipped 10.
      AUTH_RATE_LIMIT_MAX: '5000',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  child.on('exit', (code) => log.push(`\n[api exited with ${code}]`));

  const baseURL = `http://127.0.0.1:${port}`;
  try {
    await waitFor('the API to answer /health', async () => {
      try {
        const r = await fetch(`${baseURL}/health`);
        return r.ok;
      } catch {
        return false;
      }
    }, { tries: 60 });
  } catch (err) {
    throw new Error(`${err.message}\n--- api output ---\n${log.join('')}`);
  }

  return { child, baseURL, port, log };
}

async function seedAccounts(dbPort, dbPassword) {
  const client = new pg.Client({
    host: '127.0.0.1', port: dbPort, database: DB_NAME, user: DB_USER, password: dbPassword,
  });
  await client.connect();
  try {
    for (const account of Object.values(ACCOUNTS)) {
      const hash = await bcrypt.hash(account.password, 10);
      await client.query(
        `INSERT INTO users (email, name, role, password_hash, must_change_password, api_key)
         VALUES ($1, $2, $3, $4, FALSE, $5)
         ON CONFLICT (email) DO UPDATE
           SET role = EXCLUDED.role,
               password_hash = EXCLUDED.password_hash,
               must_change_password = FALSE`,
        [account.email, account.name, account.role, hash, `e2e-key-${account.role}`],
      );
    }

    // The locked-out super_admin. No password_hash at all, which is exactly what the
    // recovery script produces and what POST /api/admin/setup requires.
    await client.query(
      `INSERT INTO users (email, name, role, password_hash, must_change_password, api_key)
       VALUES ($1, $2, $3, NULL, FALSE, $4)
       ON CONFLICT (email) DO UPDATE
         SET role = EXCLUDED.role, password_hash = NULL, must_change_password = FALSE`,
      [LOCKED_SUPER_ADMIN.email, LOCKED_SUPER_ADMIN.name, LOCKED_SUPER_ADMIN.role,
        'e2e-key-locked'],
    );

    // Sessions carrying the reflection fields, so 週報月報 has rows to render and a row
    // to click. Without them every list on that page is empty and the port's actual
    // rendering — the counts, the ordering, the memory-search modal behind each row —
    // goes untested while the specs stay green on the empty states.
    //
    // NOW() rather than an offset: the report's default window is the current week, and
    // NOW() is inside it on every day of the year, which a fixed interval is not. Three
    // rows so grouping produces a count above one. On the super_admin rather than the
    // admin: the stats-dashboard spec drills into the admin and asserts its 痛點 and
    // 建議 lists are empty, and these are the very fields that populates.
    for (let i = 0; i < 3; i += 1) {
      await client.query(
        `INSERT INTO session_logs (user_id, tool, machine, summary, details, created_at)
         SELECT id, 'claude-code', 'e2e-machine', 'e2e reflective session',
                '{"project":"e2e-project","friction_points":"e2e friction: SSH kept timing out",
                  "suggestions":"e2e suggestion: retry with backoff"}'::jsonb, NOW()
           FROM users WHERE email = $1`,
        [ACCOUNTS.superAdmin.email],
      );
    }

    // A memory the seeded friction text will find. Without it the search modal can only
    // ever be seen in its empty state — which is what happened on the 2026-08-05
    // production check, where no real friction line matched any memory, so the branch
    // that actually renders results went unexercised everywhere.
    await client.query(
      `INSERT INTO memories (user_id, type, title, content, tags, status)
       SELECT id, 'project', 'e2e friction: SSH kept timing out',
              'Seeded so the periodic-report search modal has something to find.',
              ARRAY['e2e'], 'active'
         FROM users WHERE email = $1`,
      [ACCOUNTS.superAdmin.email],
    );

    // One orphan session, so the pitfalls page has something to render.
    //
    // Without it the page correctly shows its all-clear state and the three sections never
    // appear, which would leave the port's actual rendering untested. `orphan_session` is
    // the cheapest of the three to produce: a session of five turns or more carrying no
    // compliance array (src/routes/me.js). The other two need a matching activity_logs
    // pair, which is more fixture than this buys.
    await client.query(
      `INSERT INTO session_logs (user_id, tool, machine, summary, details, created_at)
       SELECT id, 'claude-code', 'e2e-machine', 'e2e orphan session',
              '{"project":"e2e-project","duration_turns":6}'::jsonb, NOW() - INTERVAL '1 day'
         FROM users WHERE email = $1`,
      [ACCOUNTS.admin.email],
    );
  } finally {
    await client.end();
  }
}

export async function startStack() {
  const dbPassword = scratchSecret();
  const dbPort = await startDatabase(dbPassword);
  const api = await startApi(dbPort, dbPassword, scratchSecret());
  // Seeding runs after the API boots, because the API is what applies the migrations.
  await seedAccounts(dbPort, dbPassword);
  return { ...api, dbPort };
}

export async function stopStack(stack) {
  if (stack?.child && !stack.child.killed) {
    stack.child.kill('SIGTERM');
    await sleep(300);
    if (!stack.child.exitCode) stack.child.kill('SIGKILL');
  }
  // --rm plus no volume means stopping the container destroys the data with it.
  try { docker(['rm', '-f', DB_CONTAINER], { stdio: 'ignore' }); } catch { /* already gone */ }
}

export const CLIENT_BUILD = join(repoRoot, 'src', 'public', 'dashboard', 'index.html');
