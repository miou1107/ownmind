/**
 * v1.17.24: user-accessible usage-report page (/ownmind/me/)
 *
 * Lets the user role log in to view:
 *   - their own activity volume, version, projects, iron-rule compliance
 *   - team-wide aggregates (Q1=C user chose fully open, no anonymization)
 *   - team-wide per-project stats (Q2=B all team projects visible)
 *   - a dedicated URL /ownmind/me/ (Q3=B)
 *
 * Auth: reuse the user's existing api_key (obtained from MCP setup, already written
 *       into Claude Code settings.json). No password-login flow (user role has no password_hash).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

test('src/routes/me.js: must exist (user-accessible usage-report route)', () => {
  assert.ok(
    existsSync(join(repoRoot, 'src', 'routes', 'me.js')),
    'src/routes/me.js must exist; provides the personal + team usage API visible to the user role'
  );
});

test('src/routes/me.js: must define /profile / /report / /login / /change-password endpoints', () => {
  const meSource = readFileSync(join(repoRoot, 'src', 'routes', 'me.js'), 'utf8');
  assert.match(meSource, /router\.get\(['"]\/profile['"]/, 'GET /profile must exist');
  assert.match(meSource, /router\.get\(['"]\/report['"]/, 'GET /report must exist');
  assert.match(meSource, /router\.post\(['"]\/login['"]/, 'POST /login (v1.17.25+ email+password)');
  assert.match(meSource, /router\.post\(['"]\/change-password['"]/, 'POST /change-password must exist');
});

test('src/routes/me.js: /login must use bcrypt.compare to verify the password', () => {
  const meSource = readFileSync(join(repoRoot, 'src', 'routes', 'me.js'), 'utf8');
  assert.match(meSource, /bcrypt\.compare/, '/login must use bcrypt.compare against password_hash');
});

test('src/routes/me.js: /change-password must clear the must_change_password flag', () => {
  const meSource = readFileSync(join(repoRoot, 'src', 'routes', 'me.js'), 'utf8');
  assert.match(
    meSource,
    /must_change_password\s*=\s*FALSE/,
    '/change-password on success must SET must_change_password = FALSE'
  );
});

test('src/jobs/seed-default-passwords.js: must exist', () => {
  assert.ok(
    existsSync(join(repoRoot, 'src', 'jobs', 'seed-default-passwords.js')),
    'seed-default-passwords.js must exist — server boot seeds default passwords'
  );
});

test('src/jobs/seed-default-passwords.js: must be idempotent (only UPDATE rows where password_hash IS NULL)', () => {
  const src = readFileSync(join(repoRoot, 'src', 'jobs', 'seed-default-passwords.js'), 'utf8');
  assert.match(src, /password_hash\s+IS\s+NULL/i, 'seed must only touch rows where password_hash IS NULL');
  assert.match(src, /must_change_password\s*=\s*TRUE/, 'when seeding the default password, must also set must_change_password = TRUE');
});

test('db/010_user_password_login.sql: must add the must_change_password column', () => {
  const sqlPath = join(repoRoot, 'db', '010_user_password_login.sql');
  assert.ok(existsSync(sqlPath), 'migration 010 must exist');
  const sql = readFileSync(sqlPath, 'utf8');
  assert.match(sql, /must_change_password\s+BOOLEAN/i, 'migration must add the must_change_password column');
});

test('admin.js POST /users: when adding a user-role with no password, server auto-fills default + must_change_password', () => {
  // v1.17.26: when adding a new user, if no password is provided (admin does not want to set one),
  // the server automatically applies Password42760988 + must_change_password=TRUE, matching the
  // seed-default-passwords behavior.
  const adminSrc = readFileSync(join(repoRoot, 'src', 'routes', 'admin.js'), 'utf8');
  // Must reference the DEFAULT_USER_PASSWORD constant or the 'Password42760988' literal.
  assert.ok(
    adminSrc.includes('Password42760988') || /DEFAULT_USER_PASSWORD/.test(adminSrc),
    'admin.js must reference the default password Password42760988'
  );
  // INSERT users must be able to write the must_change_password column.
  assert.match(
    adminSrc,
    /INSERT INTO users[\s\S]{0,400}must_change_password/,
    'POST /users INSERT must include the must_change_password column'
  );
});

test('src/routes/me.js: endpoints must use the auth middleware (accepts any role)', () => {
  const meSource = readFileSync(join(repoRoot, 'src', 'routes', 'me.js'), 'utf8');
  // Use ../middleware/auth.js (not adminAuth — otherwise the user role would be blocked).
  assert.match(
    meSource,
    /from\s+['"]\.\.\/middleware\/auth(\.js)?['"]/,
    'must import the generic auth middleware (adminAuth would block the user role)'
  );
  assert.doesNotMatch(
    meSource,
    /adminAuth|superAdminAuth/,
    'me.js must not use adminAuth — the whole point is to let the user role in'
  );
});

test('src/routes/me.js: report must return three sections — me / team / projects', () => {
  const meSource = readFileSync(join(repoRoot, 'src', 'routes', 'me.js'), 'utf8');
  // Confirm all three top-level keys appear in the source (sufficient evidence that res.json sends them).
  for (const section of ['me', 'team', 'projects']) {
    const re = new RegExp(`\\b${section}\\s*:\\s*\\{|\\b${section}\\s*:\\s*\\[|\\b${section}\\s*:\\s*team`, 'm');
    assert.ok(
      re.test(meSource) || meSource.includes(`${section}:`),
      `me.js must have a ${section}: structure as a response key`
    );
  }
});

test('src/app.js: must mount the me router + serve the /ownmind/me/ static page', () => {
  const appSource = readFileSync(join(repoRoot, 'src', 'app.js'), 'utf8');
  assert.match(
    appSource,
    /['"]\/api\/me['"]/,
    'src/app.js must mount the /api/me route'
  );
  assert.match(
    appSource,
    /['"]\/me['"]|['"]\/ownmind\/me['"]/,
    'src/app.js must serve the /me or /ownmind/me static path'
  );
});

test('src/public/me/index.html: must exist', () => {
  assert.ok(
    existsSync(join(repoRoot, 'src', 'public', 'me', 'index.html')),
    'src/public/me/index.html must exist — the user-facing report page'
  );
});

test('src/public/me/index.html: email/password login + forced password change + three sections', () => {
  const html = readFileSync(join(repoRoot, 'src', 'public', 'me', 'index.html'), 'utf8');
  // v1.17.25 switched to email + password login.
  assert.match(html, /type="email"/, 'must include an email input');
  assert.match(html, /type="password"/, 'must include a password input');
  assert.match(html, /\/api\/me\/login/, 'must call /api/me/login (POST email/password)');
  assert.match(html, /\/api\/me\/change-password/, 'must call /change-password (forced password change)');
  assert.match(html, /must_change_password/, 'must handle the must_change_password flag branch');
  assert.match(html, /\/api\/me\/report/, 'must fetch /api/me/report for data');
  assert.match(html, /localStorage/, 'must use localStorage for session storage');
  for (const word of ['個人', '團隊', '專案']) {
    assert.ok(html.includes(word), `me/index.html must contain the "${word}" section`);
  }
});
