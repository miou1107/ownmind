/**
 * v1.26.48 — Stage 1b of single-console-consolidation.
 *
 * The root path stops pointing at the legacy `/admin/` and points at the
 * console at `/dashboard/`. `/me` and `/me/*` are retired to 301s that land on
 * the console's usage page. Every Location emitted is relative — the app must
 * run behind an `/ownmind` reverse proxy (nginx strips it before proxying) and
 * also plain at `/`, so a hardcoded prefix is not an option.
 *
 * See openspec/changes/v1.26.48-flip-root-retire-me/spec.md.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// src/utils/crypto.js calls process.exit(1) when ENCRYPTION_KEY is unset at
// import time. Set a test-only key before importing app, mirroring
// tests/spa-deep-link-base.test.js.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
  || 'test-only-encryption-key-32-chars-x';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

let app;
before(async () => {
  ({ default: app } = await import('../src/app.js'));
});

/**
 * Send a single request through the app and return the response envelope.
 *
 * Manually managed listener because supertest is not a dependency here and the
 * existing tests use the same shape (tests/spa-deep-link-base.test.js).
 */
async function fetchOnce(urlPath, { method = 'GET' } = {}) {
  return await new Promise((resolve, reject) => {
    const srv = app.listen(0, async () => {
      try {
        const port = srv.address().port;
        const r = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
          method,
          redirect: 'manual',
        });
        const body = await r.text().catch(() => '');
        srv.close();
        resolve({
          status: r.status,
          location: r.headers.get('location'),
          body,
        });
      } catch (err) {
        srv.close();
        reject(err);
      }
    });
  });
}

/**
 * Resolve a Location against a base URL exactly as a browser would.
 *
 * Assertions target the resolved absolute URL rather than the raw Location,
 * so the same emitted value is exercised for both `/` and `/ownmind/`.
 */
function resolveLocation(base, location) {
  return new URL(location, base).href;
}

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 1 — root redirects to the console, and the same emitted value
// resolves correctly both bare and behind the /ownmind prefix.
// ─────────────────────────────────────────────────────────────────────────────

describe('v1.26.48 — root redirect points at the console', () => {
  it('GET / responds with a redirect', async () => {
    const r = await fetchOnce('/');
    assert.ok(
      r.status === 301 || r.status === 302,
      `expected 301/302 from GET /, got ${r.status}`,
    );
    assert.ok(r.location, 'Location header must be present');
  });

  it('the emitted Location is relative (does not start with "/")', async () => {
    const r = await fetchOnce('/');
    assert.ok(
      !r.location.startsWith('/'),
      `Location must be relative, got "${r.location}"`,
    );
  });

  it('resolves to /dashboard/ with no proxy prefix', async () => {
    const r = await fetchOnce('/');
    const resolved = resolveLocation('http://example.com/', r.location);
    assert.equal(resolved, 'http://example.com/dashboard/');
  });

  it('resolves to /ownmind/dashboard/ under the /ownmind prefix', async () => {
    // Express sees `/` because nginx strips the prefix. The browser resolves
    // the emitted Location against its actual current URL, which does carry
    // the prefix. So we take the same Location Express emitted for GET / and
    // resolve it against the prefixed URL the browser saw.
    const r = await fetchOnce('/');
    const resolved = resolveLocation('http://example.com/ownmind/', r.location);
    assert.equal(resolved, 'http://example.com/ownmind/dashboard/');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 2 — /me and /me/* land on the console usage page. One terminal
// URL, three request shapes, each needs a differently-relative Location.
// ─────────────────────────────────────────────────────────────────────────────

describe('v1.26.48 — /me family retires to the console usage page', () => {
  it('GET /me → 301 to dashboard/portal/usage (relative)', async () => {
    const r = await fetchOnce('/me');
    assert.equal(r.status, 301);
    assert.ok(r.location, 'Location header must be present');
    assert.ok(
      !r.location.startsWith('/'),
      `Location must be relative, got "${r.location}"`,
    );
    // /me sits at the root's directory, so `dashboard/portal/usage` alone works
    const resolved = resolveLocation('http://example.com/ownmind/me', r.location);
    assert.equal(resolved, 'http://example.com/ownmind/dashboard/portal/usage');
  });

  it('GET /me/ (trailing slash) → 301, same terminal URL', async () => {
    const r = await fetchOnce('/me/');
    assert.equal(r.status, 301);
    assert.ok(!r.location.startsWith('/'));
    const resolved = resolveLocation('http://example.com/ownmind/me/', r.location);
    assert.equal(resolved, 'http://example.com/ownmind/dashboard/portal/usage');
  });

  it('GET /me/foo → 301, deep segment discarded', async () => {
    const r = await fetchOnce('/me/foo');
    assert.equal(r.status, 301);
    assert.ok(!r.location.startsWith('/'));
    const resolved = resolveLocation('http://example.com/ownmind/me/foo', r.location);
    assert.equal(resolved, 'http://example.com/ownmind/dashboard/portal/usage');
  });

  it('GET /me/foo/bar (two segments deep) → 301, same terminal URL', async () => {
    const r = await fetchOnce('/me/foo/bar');
    assert.equal(r.status, 301);
    const resolved = resolveLocation('http://example.com/ownmind/me/foo/bar', r.location);
    assert.equal(resolved, 'http://example.com/ownmind/dashboard/portal/usage');
  });

  it('GET /me does not serve the legacy HTML at any URL under /me', async () => {
    // If the static mount stayed by mistake, /me/index.html would 200 with
    // the legacy file. It must not.
    const r = await fetchOnce('/me/index.html');
    assert.notEqual(r.status, 200, 'legacy /me/index.html must not be served');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement — structural: no hardcoded /ownmind literal inside any
// res.redirect(...) call in the two files this stage touches.
// ─────────────────────────────────────────────────────────────────────────────

describe('v1.26.48 — no hardcoded /ownmind literal in redirect targets', () => {
  const filesToScan = [
    'src/app.js',
    'src/middleware/first-run-redirect.js',
  ];

  for (const rel of filesToScan) {
    it(`${rel} contains no /ownmind literal inside res.redirect(...)`, () => {
      const source = readFileSync(path.join(repoRoot, rel), 'utf8');

      // Match res.redirect calls, capture the argument list up to the closing paren
      // Requires exact `res.redirect(` textual form — the middleware and app both use it
      const redirectCalls = source.match(/res\.redirect\([^)]*\)/g) || [];
      assert.ok(
        redirectCalls.length > 0,
        `${rel} is expected to contain at least one res.redirect call — `
        + `if it no longer does, this test needs updating`,
      );

      for (const call of redirectCalls) {
        assert.ok(
          !call.includes('/ownmind'),
          `${rel} has a res.redirect that hardcodes /ownmind: ${call}`,
        );
      }
    });
  }
});
