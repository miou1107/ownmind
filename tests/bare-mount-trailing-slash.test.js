// v1.26.57 — the bare mount path must redirect *inside* the reverse-proxy prefix.
//
// Found on production 2026-08-04: `https://kkvin.com/ownmind/dashboard` (no trailing
// slash) answered `301 Location: /dashboard/`, an absolute path that drops the
// `/ownmind` prefix and lands the browser on an unrelated site. `/ownmind/admin` did the
// same. Neither redirect is written by this codebase — both come from express.static's
// built-in `redirect: true`, which builds its Location from the path Express sees, after
// nginx has already stripped the prefix.
//
// v1.26.48 converted every redirect the app writes itself to a relative Location. It
// could not reach these two, because serve-static emits them.
//
// Assertions resolve the emitted Location against TWO bases, the way the v1.26.48 tests
// do. A raw string comparison passes for the broken absolute form — `/dashboard/` looks
// perfectly fine until you resolve it against `http://x/ownmind/` — and that is exactly
// how this survived unnoticed.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { redirectBareMountPath } from '../src/middleware/bare-mount-redirect.js';
import { installLegacyAdminMount } from '../src/middleware/legacy-admin-mount.js';
import { isLegacyConsoleRetired } from '../shared/legacy-console-manifest.js';
import { connect } from 'node:net';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// src/utils/crypto.js calls process.exit(1) when ENCRYPTION_KEY is unset at import
// time. Set a test-only key before importing app, mirroring the v1.26.48 tests.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
  || 'test-only-encryption-key-32-chars-x';

let app;
before(async () => {
  ({ default: app } = await import('../src/app.js'));
});

async function fetchOnce(target, urlPath, { method = 'GET' } = {}) {
  return await new Promise((resolve, reject) => {
    const srv = target.listen(0, async () => {
      try {
        const { port } = srv.address();
        const r = await fetch(`http://127.0.0.1:${port}${urlPath}`, { method, redirect: 'manual' });
        const body = await r.text().catch(() => '');
        srv.close();
        resolve({ status: r.status, location: r.headers.get('location'), body });
      } catch (err) {
        srv.close();
        reject(err);
      }
    });
  });
}

/**
 * Send a hand-written request line. fetch() normalises the URL and will not emit an
 * absolute-form target, so the one shape that reflects a client-supplied host into the
 * Location can only be exercised at the socket.
 */
async function rawRequestLocation(requestLine) {
  return await new Promise((resolve, reject) => {
    const srv = app.listen(0, () => {
      const s = connect(srv.address().port, '127.0.0.1', () => {
        s.write(`${requestLine}\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
      });
      let buf = '';
      // `srv.close()` only stops accepting; it then waits for live connections to end.
      // Destroying the *client* socket is not enough — the server side stays open, the
      // close callback never fires, and node --test reports the file as cancelled after
      // its timeout. `closeAllConnections()` is what actually drops it.
      const finish = (err, value) => {
        s.destroy();
        srv.closeAllConnections();
        srv.close(() => (err ? reject(err) : resolve(value)));
      };
      s.on('data', (d) => { buf += d; });
      s.on('error', (err) => finish(err));
      s.on('end', () => {
        const m = buf.match(/^Location:\s*(.*)$/mi);
        finish(null, m ? m[1].trim() : null);
      });
    });
  });
}

/** Resolve a Location exactly as a browser would. */
const resolveLocation = (base, location) => new URL(location, base).href;

/**
 * The whole point of the fix, asserted in one place: one emitted value has to be right
 * under both deployments.
 */
function assertResolvesUnderBothBases(location, bare, prefixed) {
  assert.ok(location, 'Location header must be present');
  assert.ok(
    !location.startsWith('/'),
    `Location must be relative or it cannot survive the proxy prefix, got "${location}"`,
  );
  assert.equal(resolveLocation('http://x/', location), bare);
  assert.equal(resolveLocation('http://x/ownmind/', location), prefixed);
}

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 1 — the bare mount path stays inside the prefix
// ─────────────────────────────────────────────────────────────────────────────

describe('v1.26.57 — /dashboard with no trailing slash', () => {
  it('redirects rather than serving anything', async () => {
    const r = await fetchOnce(app, '/dashboard');
    assert.equal(r.status, 301);
  });

  it('the same emitted Location is correct with and without the /ownmind prefix', async () => {
    const r = await fetchOnce(app, '/dashboard');
    assertResolvesUnderBothBases(
      r.location,
      'http://x/dashboard/',
      'http://x/ownmind/dashboard/',
    );
  });

  it('specifically does NOT emit the absolute form production was serving', async () => {
    // The literal regression. Kept as its own assertion so the failure message names
    // the bug rather than showing a URL diff.
    const r = await fetchOnce(app, '/dashboard');
    assert.notEqual(r.location, '/dashboard/', 'this is the exact value that broke production');
  });
});

describe('v1.26.57 — /admin with no trailing slash', () => {
  // Which behaviour is correct depends on which branch the manifest installed, so the
  // branch is read rather than guessed. An earlier version of this test asserted only
  // "relative, and somewhere under the prefix", which stayed green even if the helper
  // sent /admin to `dashboard/` — it could not tell the two branches apart at all.
  it('lands on the legacy console directory while signposts remain', async (t) => {
    if (isLegacyConsoleRetired()) return t.skip('legacy console retired; see the retired-branch suite');
    const r = await fetchOnce(app, '/admin');
    assert.equal(r.status, 301);
    assertResolvesUnderBothBases(r.location, 'http://x/admin/', 'http://x/ownmind/admin/');
  });

  it('lands on the console once the legacy console is retired', async (t) => {
    if (!isLegacyConsoleRetired()) return t.skip('legacy console still served; see the suite above');
    const r = await fetchOnce(app, '/admin');
    assert.equal(r.status, 301);
    assertResolvesUnderBothBases(r.location, 'http://x/dashboard/', 'http://x/ownmind/dashboard/');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 1 — the matching surface must be at least as wide as serve-static's
//
// Found in review by probing the running app. Each of these three slipped past the
// first version of the handler and fell straight back into the absolute Location.
// ─────────────────────────────────────────────────────────────────────────────

describe('v1.26.57 — request shapes that used to bypass the guard', () => {
  it('a case variant of the mount path is still caught', async () => {
    // Express mounts are case-insensitive by default, so /Dashboard enters the mount.
    // A case-sensitive comparison let it through and serve-static answered
    // `Location: /Dashboard/` — the production bug, unfixed, one keystroke away.
    for (const p of ['/Dashboard', '/DASHBOARD', '/dashBoard']) {
      const r = await fetchOnce(app, p);
      assert.equal(r.status, 301, p);
      assert.ok(!r.location.startsWith('/'), `${p}: got absolute "${r.location}"`);
      assert.equal(
        resolveLocation(`http://x/ownmind${p}`, r.location),
        'http://x/ownmind/dashboard/',
        `${p} must stay in the prefix and normalise to the real path`,
      );
    }
    const r = await fetchOnce(app, '/Admin');
    assert.equal(resolveLocation('http://x/ownmind/Admin', r.location), 'http://x/ownmind/admin/');
  });

  it('an absolute-form request line cannot reflect its host into the Location', async () => {
    // `GET http://evil.example/dashboard HTTP/1.1` is legal in RFC 9112 and fetch()
    // refuses to send it, so this needs a raw socket. serve-static answered
    // `Location: http://evil.example/dashboard/`, reflecting a client-supplied host.
    const loc = await rawRequestLocation('GET http://evil.example/dashboard HTTP/1.1');
    assert.ok(loc, 'expected a redirect');
    assert.ok(
      !/^[a-z]+:|^\/\//i.test(loc),
      `Location must not carry a scheme or authority, got "${loc}"`,
    );
    assert.equal(loc, 'dashboard/', 'depth must come from the normalised path, not the raw URL');
  });

  it('a method serve-static never redirected is passed through untouched', async () => {
    // serve-static only redirects GET and HEAD. Answering POST with a 301 would be a
    // behaviour change smuggled in by a bug fix.
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await fetchOnce(app, '/dashboard', { method });
      assert.notEqual(r.status, 301, `${method} must not be redirected`);
    }
    const head = await fetchOnce(app, '/dashboard', { method: 'HEAD' });
    assert.equal(head.status, 301, 'HEAD must redirect, as serve-static did');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 2 — no redirect loop, and nothing else is intercepted
// ─────────────────────────────────────────────────────────────────────────────

describe('v1.26.57 — the handler matches the bare path only', () => {
  it('/dashboard/ is served, not redirected', async () => {
    // The loop this fix could introduce: `app.get('/dashboard')` also matches
    // `/dashboard/` under Express's default non-strict routing, and redirecting that to
    // the relative `dashboard/` resolves to `/dashboard/dashboard/` — forever.
    const r = await fetchOnce(app, '/dashboard/');
    assert.notEqual(r.status, 301, '/dashboard/ must not redirect — that is an infinite loop');
    assert.equal(r.status, 200);
  });

  it('a deep console route still reaches the SPA shell', async () => {
    const r = await fetchOnce(app, '/dashboard/portal/usage');
    assert.equal(r.status, 200);
    assert.match(r.body, /<base href=/, 'the SPA shell handler must still answer');
  });

  it('/admin/ is still served by the legacy console', async () => {
    const r = await fetchOnce(app, '/admin/');
    assert.equal(r.status, 200);
    assert.match(r.body, /data-tab="users"/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 3 — the query string survives
// ─────────────────────────────────────────────────────────────────────────────

describe('v1.26.57 — query strings', () => {
  it('a query on the bare path is carried through', async () => {
    // serve-static preserved it (`/dashboard?a=1` → `/dashboard/?a=1`), so losing it
    // would be a regression introduced by this fix rather than a pre-existing one.
    const r = await fetchOnce(app, '/dashboard?tab=x&y=1');
    assert.equal(
      resolveLocation('http://x/ownmind/', r.location),
      'http://x/ownmind/dashboard/?tab=x&y=1',
    );
  });

  it('no query means no stray question mark', async () => {
    const r = await fetchOnce(app, '/dashboard');
    assert.ok(!r.location.includes('?'), `got "${r.location}"`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 4 — one helper, and it fails closed on a mount path it cannot handle
// ─────────────────────────────────────────────────────────────────────────────

describe('v1.26.57 — redirectBareMountPath in isolation', () => {
  function appWith(mountPath) {
    const a = express();
    redirectBareMountPath(a, mountPath);
    a.use(mountPath, (req, res) => res.status(200).send('served'));
    return a;
  }

  it('derives the target from the mount path, so the two cannot disagree', async () => {
    const r = await fetchOnce(appWith('/anything'), '/anything');
    assertResolvesUnderBothBases(
      r.location,
      'http://x/anything/',
      'http://x/ownmind/anything/',
    );
  });

  it('lets everything that is not the bare path through', async () => {
    const a = appWith('/anything');
    for (const p of ['/anything/', '/anything/deep', '/anything/deep/er']) {
      const r = await fetchOnce(a, p);
      assert.equal(r.status, 200, `${p} must not be intercepted`);
    }
  });

  it('throws at install time on a mount path it cannot handle', () => {
    // Fail closed. A silently-installed handler for `/` would redirect the root to
    // itself; one for a path with a query would build a nonsense target.
    for (const bad of ['', '/', 'dashboard', '/a/b', '/a?x=1', null, undefined]) {
      assert.throws(
        () => redirectBareMountPath(express(), bad),
        /mount path/i,
        `${JSON.stringify(bad)} should be refused`,
      );
    }
  });

  it('accepts the two mount paths the app actually uses', () => {
    assert.doesNotThrow(() => redirectBareMountPath(express(), '/dashboard'));
    assert.doesNotThrow(() => redirectBareMountPath(express(), '/admin'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 1, retired branch — /admin as a redirect rather than a static mount
// ─────────────────────────────────────────────────────────────────────────────

describe('v1.26.57 — the retired /admin branch is unaffected', () => {
  it('still redirects to the console, inside the prefix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'legacy-'));
    writeFileSync(join(dir, 'index.html'), '<h1>legacy</h1>');
    const a = express();
    installLegacyAdminMount(a, { retired: true, publicDir: dir });

    for (const p of ['/admin', '/admin/', '/admin/deep']) {
      const r = await fetchOnce(a, p);
      assert.equal(r.status, 301, p);
      assert.ok(!r.location.startsWith('/'), `${p}: Location must be relative`);
      assert.equal(
        resolveLocation(`http://x/ownmind${p}`, r.location),
        'http://x/ownmind/dashboard/',
        `${p} must land on the console inside the prefix`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 5 — the redirects v1.26.48 already fixed must stay fixed
// ─────────────────────────────────────────────────────────────────────────────

describe('v1.26.57 — no regression in the paths v1.26.48 made relative', () => {
  it('/ still resolves to the console under both bases', async () => {
    const r = await fetchOnce(app, '/');
    assertResolvesUnderBothBases(
      r.location,
      'http://x/dashboard/',
      'http://x/ownmind/dashboard/',
    );
  });

  it('/me resolves to the console usage page under both bases', async () => {
    const r = await fetchOnce(app, '/me');
    assert.equal(r.status, 301);
    assert.equal(
      resolveLocation('http://x/ownmind/me', r.location),
      'http://x/ownmind/dashboard/portal/usage',
    );
    assert.equal(
      resolveLocation('http://x/me', r.location),
      'http://x/dashboard/portal/usage',
    );
  });

  it('every static mount in src/ is preceded by a bare-path handler', () => {
    // A structural guard rather than a behavioural one: the next person to add an
    // express.static mount inherits this bug unless they call the helper. This repo has
    // no CI, so it is a floor rather than a proof — but the count is asserted, so a new
    // mount cannot slip in unnoticed.
    // Walks all of src/ rather than a hardcoded pair: a new mount added in a new file
    // is exactly the case this is meant to catch, and a two-filename list would miss it.
    const found = [];
    for (const file of walkJs(join(repoRoot, 'src'))) {
      const src = readFileSync(file, 'utf8');
      const n = (src.match(/express\.static\(/g) || []).length;
      if (n > 0) found.push(`${file.slice(repoRoot.length + 1)} x${n}`);
    }
    assert.deepEqual(
      found.sort(),
      ['src/app.js x1', 'src/middleware/legacy-admin-mount.js x1'],
      'a new express.static mount needs redirectBareMountPath in front of it',
    );
  });
});

/** Every .js file under a directory, recursively. */
function walkJs(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJs(full));
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}
