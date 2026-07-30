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
      SETUP_TOKEN: '',
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
