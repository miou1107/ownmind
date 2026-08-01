/**
 * v1.26.49 — GET /api/admin/users must return `must_change_password`.
 *
 * Regression guard for the code-review Critical finding: the SELECT list at
 * src/routes/admin.js originally omitted `must_change_password`. Undefined-in-JS
 * is falsy, so the new "密碼狀態" column silently rendered every user as "已改",
 * even the ones still on their seed password. That's the exact class of failure
 * the umbrella spec's Requirement 7 was written against (unmeasured is not the
 * same as measured-zero) — here, "password not disclosed by API" is not the
 * same as "user has changed their password".
 *
 * Source-text assertion because the repo doesn't have a factory for the main
 * admin router (mock injection is only wired for admin-password-reset). Widening
 * an existing SELECT is safe, so a text check is enough to catch the regression.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe('GET /api/admin/users — response shape', () => {
  const src = readFileSync(join(repoRoot, 'src/routes/admin.js'), 'utf8');

  it("SELECT list includes must_change_password so the team page's 密碼狀態 column can render", () => {
    // Grep for the listUsers handler's SELECT: it lives on the router.get('/users', ...) route.
    // Anchor on the FROM users ORDER BY clause the handler uses.
    const selectRegion = src.match(/SELECT[\s\S]{0,400}FROM users ORDER BY created_at DESC/);
    assert.ok(selectRegion, 'listUsers SELECT ... FROM users ORDER BY created_at DESC not found');
    assert.match(
      selectRegion[0],
      /must_change_password/,
      'listUsers must return must_change_password — the team page relies on it to render the 密碼狀態 column',
    );
  });

  it('SELECT list does not accidentally return password_hash', () => {
    // Belt-and-suspenders. If someone widens the SELECT to `SELECT * FROM users`
    // to fix must_change_password quickly, the password hash would ship over the
    // wire in a payload that admins routinely have open in browser devtools.
    const selectRegion = src.match(/SELECT[\s\S]{0,400}FROM users ORDER BY created_at DESC/);
    assert.ok(selectRegion);
    assert.doesNotMatch(
      selectRegion[0],
      /password_hash/,
      'listUsers must NOT return password_hash — it would leak a bcrypt digest to every admin session',
    );
    assert.doesNotMatch(selectRegion[0], /SELECT \*/, 'do not SELECT * here — it would include password_hash');
  });
});
