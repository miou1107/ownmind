import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

/**
 * v1.20.1 — me.js POST /change-password must return 400 for a wrong old password, not 401.
 *
 * Background: after v1.20.1 step 3.10 enabled the auth guard, client.js clears the api_key
 * and broadcasts ownmind:auth-expired on any 401; App.jsx then navigates to /login.
 *
 * But me.js POST /change-password (line 89) originally returned 401 on a wrong old password,
 * so a mustChange user who mistyped on SecurityPage was immediately kicked to /login —
 * which completely broke the password-change UX.
 *
 * Fix: switch the wrong-old-password response back to 400 (this handler sits after
 * router.use(auth), so the token is already valid). 401 is reserved for "identity fully
 * invalidated" and stays separate from change-password failures.
 */

describe('v1.20.1 — POST /change-password status code for wrong old password', () => {
  const meSource = readFileSync(join(repoRoot, 'src/routes/me.js'), 'utf8');

  // Pull the whole change-password handler section.
  const handlerMatch = meSource.match(
    /router\.post\(['"]\/change-password['"][\s\S]+?(?=\n(?:router\.|export default))/
  );

  it('change-password handler must exist', () => {
    assert.ok(handlerMatch, 'POST /change-password handler not found');
  });

  it('handler must not call status(401) anywhere', () => {
    assert.ok(handlerMatch);
    // change-password sits after router.use(auth); the token has already been validated
    // by middleware, so no failure in this handler should still return 401 (avoid the
    // client.js 401 burst handler misfiring).
    assert.doesNotMatch(handlerMatch[0], /status\(401\)/,
      'change-password handler must not call status(401) anywhere; 401 would be treated as expired token and kick the user back to /login');
  });

  it('wrong-old-password response must be 400', () => {
    assert.ok(handlerMatch);
    // Find the nearest status(N) call within 80 chars before "舊密碼錯誤".
    // Reverse match to capture the last status that precedes it.
    const m = handlerMatch[0].match(/status\((\d+)\)[\s\S]{0,80}?舊密碼錯誤/);
    assert.ok(m, 'status call for the "wrong old password" response not found');
    assert.equal(m[1], '400',
      'wrong old password must return 400 — semantically "user input error", separate from "expired token" (401)');
  });
});
