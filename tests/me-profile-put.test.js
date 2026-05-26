import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.20.1 — add PUT /api/me/profile endpoint
 *
 * Background: v1.17.24 added GET /api/me/profile so users could view their
 * own profile, but no matching PUT. The dashboard's personal Preference >
 * profile page needs to be able to edit name, so v1.20.1 fills that in.
 *
 * Design decisions:
 *   - Only name is editable; users cannot change their own email / role
 *     (only admin / super_admin may change role).
 *   - name (after trim) cannot be empty; length 1–100.
 *   - Response shape matches GET /profile so the client can overwrite state directly.
 */

describe('v1.20.1 — PUT /api/me/profile (edit personal profile)', () => {
  const meSource = fs.readFileSync(path.join(repoRoot, 'src/routes/me.js'), 'utf8');

  // Grab the PUT /profile handler block (from router.put('/profile' to the next router. or export).
  const putHandlerMatch = meSource.match(
    /router\.put\(['"]\/profile['"][\s\S]+?(?=\n(?:router\.|export default))/
  );

  it('me.js must register PUT /profile route', () => {
    assert.match(meSource, /router\.put\(['"]\/profile['"]/,
      'PUT /profile must exist');
  });

  it('PUT /profile handler must come after router.use(auth) (Bearer auth required)', () => {
    const authIdx = meSource.indexOf('router.use(auth)');
    const putIdx = meSource.search(/router\.put\(['"]\/profile['"]/);
    assert.ok(authIdx > 0, 'router.use(auth) not found');
    assert.ok(putIdx > authIdx,
      'PUT /profile must come after router.use(auth) so the auth middleware can block unauthenticated requests');
  });

  it('PUT handler must trim name before validating', () => {
    assert.ok(putHandlerMatch, 'PUT /profile handler block not found');
    assert.match(putHandlerMatch[0], /\.trim\(\)/,
      'name must be trimmed before validation (so whitespace-only values do not pass)');
  });

  it('PUT handler must reject empty name (400)', () => {
    assert.ok(putHandlerMatch);
    // Verify length check + 400 response.
    assert.match(putHandlerMatch[0], /status\(400\)/,
      'invalid name must respond 400');
  });

  it('PUT handler must enforce a name length cap (≤ 100)', () => {
    assert.ok(putHandlerMatch);
    assert.match(putHandlerMatch[0], /100/,
      'name length cap 100 — avoid blowing out the DB column or breaking the UI layout');
  });

  it('PUT handler must UPDATE only the name column; never email / role', () => {
    assert.ok(putHandlerMatch);
    // Verify SQL contains SET name = ...
    assert.match(putHandlerMatch[0], /UPDATE\s+users\s+SET\s+name\s*=/i,
      'UPDATE may only edit the name column');
    // Ensure no SET email or SET role anywhere (even if body carries them, ignore them).
    assert.doesNotMatch(putHandlerMatch[0], /SET[^;]*\bemail\s*=/i,
      'UPDATE must not contain email = ...');
    assert.doesNotMatch(putHandlerMatch[0], /SET[^;]*\brole\s*=/i,
      'UPDATE must not contain role = ...');
  });

  it('PUT handler must use req.user.id (not an id from the body, to prevent privilege escalation)', () => {
    assert.ok(putHandlerMatch);
    assert.match(putHandlerMatch[0], /req\.user\.id/,
      'WHERE clause must lock to req.user.id; the caller cannot specify an id');
  });

  it('PUT handler response shape must match GET /profile', () => {
    assert.ok(putHandlerMatch);
    // GET /profile returns { id, name, email, role, created_at, must_change_password }.
    assert.match(putHandlerMatch[0], /res\.json\(/,
      'PUT must res.json(...) the updated row');
    assert.match(putHandlerMatch[0], /name/, 'response must include name');
    assert.match(putHandlerMatch[0], /email/, 'response must include email');
    assert.match(putHandlerMatch[0], /role/, 'response must include role');
  });

  it('PUT handler must have try/catch + logger.error (IR-038 observability)', () => {
    assert.ok(putHandlerMatch);
    assert.match(putHandlerMatch[0], /try\s*\{/, 'PUT handler must wrap try/catch');
    assert.match(putHandlerMatch[0], /logger\.error/,
      'on failure, logger.error must be called; never silent-fail');
    assert.match(putHandlerMatch[0], /status\(500\)/,
      'catch must respond 500');
  });

  it('logger.error must include stack (consistent with other handlers like me/report)', () => {
    assert.ok(putHandlerMatch);
    // stack is essential for debugging (every other handler like me/report includes it).
    assert.match(putHandlerMatch[0], /stack:\s*err\.stack/,
      'logger.error must include stack: err.stack, matching existing handlers');
  });

  it('UPDATE must check rowCount === 0 → 404 (race: user got deleted)', () => {
    assert.ok(putHandlerMatch);
    // Defend against silent fail: token may still be valid but the user row was deleted by an admin;
    // we must not pretend 200 succeeded.
    assert.match(putHandlerMatch[0], /rowCount\s*===\s*0/,
      'UPDATE must check rowCount === 0');
    assert.match(putHandlerMatch[0], /status\(404\)/,
      'rowCount === 0 must respond 404');
  });
});
