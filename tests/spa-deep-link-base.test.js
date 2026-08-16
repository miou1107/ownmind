import { describe, it } from 'node:test';
import { startServer } from './helpers/app-server.js';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { tempDir } from './helpers/temp-dir.js';

/**
 * v1.26.44 — a hard load of a dashboard deep link must not render a blank page.
 *
 * Reported during the v1.26.41 post-deploy browser check, confirmed pre-existing.
 *
 * Symptom: opening https://example.com/ownmind/dashboard/portal/handoffs directly
 * renders nothing, with no console error, because the bundle never loads.
 *
 * Root cause: Express serves the SPA shell for the deep route, but the shell
 * carries a relative `<base href="./">` and relative asset references. A relative
 * base resolves against the document's own address, so on a two-segment route the
 * base lands on /ownmind/dashboard/portal/ and the asset request 404s.
 *
 * Fix: when Express serves the shell it rewrites the base href to the number of
 * `../` steps that climb from the requested route back to the mount root. The
 * emitted value stays purely relative, so the nginx /ownmind prefix (which Express
 * never sees) is neither needed nor assumed, and prefix-agnostic mounting is
 * preserved.
 *
 * See openspec/changes/archive/v1.26.44-spa-deep-link-base/spec.md.
 */

// src/utils/crypto.js calls process.exit(1) when ENCRYPTION_KEY is unset at
// import time. Set a test-only key before importing app, so `npm test` needs no
// env prefix (same approach as tests/bootstrap-routes.test.js).
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
  || 'test-only-encryption-key-32-chars-x';
const { default: app } = await import('../src/app.js');
const { relativeBaseHref, withBaseHref, createSpaShellHandler } =
  await import('../src/utils/spa-shell.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

// src/public/dashboard/ is the vite build output and is gitignored, so on a fresh
// clone that has not run `npm run build:client` it does not exist. Tests that need
// the real shell are skipped there rather than failing; the invariant itself is
// covered unconditionally by the fixture suite below, which builds its own shell.
const builtShellPath = path.join(repoRoot, 'src', 'public', 'dashboard', 'index.html');
const hasBuiltShell = existsSync(builtShellPath);
const needsBuild = hasBuiltShell
  ? false
  : 'requires the client build (src/public/dashboard/); run npm run build:client';

// v1.26.158 — through the shared helper: `listen(0)` can hand back a port `fetch` refuses to
// dial, which is the v1.26.143 finding. See tests/helpers/app-server.js.
async function listenApp(target = app) {
  const started = await startServer(createServer(target));
  return { server: { close: started.close }, base: started.url };
}

function extractBaseHref(html) {
  const m = html.match(/<base\s[^>]*href="([^"]*)"/i);
  return m ? m[1] : null;
}

/** Every asset the shell references, as written in the HTML. */
function extractAssetRefs(html) {
  return [...html.matchAll(/(?:src|href)="((?:\.\.?\/)[^"]*\.(?:js|css))"/gi)]
    .map((m) => m[1]);
}

/**
 * A controlled shell plus real asset files on disk, so the end-to-end invariant is
 * proven even where the vite output is absent. This is the suite that must never
 * be skipped: it owns the "assets are actually reachable" proof.
 */
async function withFixtureApp(fn) {
  const dir = tempDir('ownmind-spa-');
  try {
    mkdirSync(path.join(dir, 'assets'), { recursive: true });
    writeFileSync(path.join(dir, 'assets', 'index-fixture.js'), '// asset\n');
    writeFileSync(path.join(dir, 'assets', 'index-fixture.css'), '/* asset */\n');
    writeFileSync(path.join(dir, 'index.html'),
      '<!doctype html>\n<html lang="zh-TW">\n  <head>\n    <base href="./" />\n'
      + '    <script type="module" src="./assets/index-fixture.js"></script>\n'
      + '    <link rel="stylesheet" href="./assets/index-fixture.css">\n'
      + '  </head>\n  <body><div id="root"></div></body>\n</html>\n');

    const probe = express();
    probe.use('/dashboard', express.static(dir));
    probe.use('/dashboard', createSpaShellHandler(path.join(dir, 'index.html')));
    // Must await: a synchronous try/finally around a promise-returning call would
    // delete the fixture before the test body ever read it, and every request
    // would 404 for the wrong reason.
    return await fn(probe);
  } finally {
    // Best-effort, and deliberately so. `tempDir` already registered this directory for
    // removal at the end of the file, and that path is written to tolerate a locked file;
    // this call is only here to free the fixture between cases. On Windows the static
    // handler's handles on ./assets are not always released by the time this runs, and the
    // rmdir then fails with ENOTEMPTY — which turned a green suite red on the Windows leg,
    // in a test about base-href resolution, for a reason that had nothing to do with it.
    // Retries first, because usually the handle is about to go; silence after, because the
    // registered cleanup is the one with teeth.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch { /* the file-level cleanup owns this directory */ }
  }
}

describe('v1.26.44 — base href resolution, against a fixture shell (no build needed)', () => {
  const cases = [
    ['/dashboard/login', './'],
    ['/dashboard/portal/handoffs', '../'],
    ['/dashboard/preference/vault', '../'],
    ['/dashboard/portal/handoffs/', '../../'],
    ['/dashboard/a/b/c/d', '../../../'],
  ];

  for (const [route, expected] of cases) {
    it(`GET ${route} serves base href "${expected}"`, async () => {
      await withFixtureApp(async (probe) => {
        const { server, base } = await listenApp(probe);
        try {
          const res = await fetch(`${base}${route}`);
          assert.equal(res.status, 200);
          assert.equal(extractBaseHref(await res.text()), expected);
        } finally {
          server.close();
        }
      });
    });
  }

  it('every referenced asset resolves and returns 200, at every depth', async () => {
    // The assertion that fails before the fix: resolve each reference the way a
    // browser would, from the request URL, and fetch it.
    await withFixtureApp(async (probe) => {
      const { server, base } = await listenApp(probe);
      try {
        for (const route of ['/dashboard/login', '/dashboard/portal/handoffs', '/dashboard/a/b/c/d']) {
          const requestUrl = `${base}${route}`;
          const html = await (await fetch(requestUrl)).text();
          const baseUrl = new URL(extractBaseHref(html), requestUrl);
          const refs = extractAssetRefs(html);
          assert.equal(refs.length, 2, `expected js + css refs for ${route}`);
          for (const ref of refs) {
            const resolved = new URL(ref, baseUrl);
            const assetRes = await fetch(resolved);
            assert.equal(assetRes.status, 200,
              `${route}: ${ref} resolved to ${resolved.pathname} and returned ${assetRes.status}`);
          }
        }
      } finally {
        server.close();
      }
    });
  });

  it('the unpatched behaviour really was broken, at the same depth', async () => {
    // Guards against the fix being a no-op: serve the shell verbatim, the way it
    // was served before, and confirm the asset 404s. Builds its own fixture rather
    // than using withFixtureApp, because it needs the *old* handler wired up.
    {
      const dir = tempDir('ownmind-spa-old-');
      try {
        mkdirSync(path.join(dir, 'assets'), { recursive: true });
        writeFileSync(path.join(dir, 'assets', 'index-fixture.js'), '// asset\n');
        writeFileSync(path.join(dir, 'index.html'),
          '<!doctype html><html><head><base href="./" />'
          + '<script src="./assets/index-fixture.js"></script></head><body></body></html>\n');

        const old = express();
        old.use('/dashboard', express.static(dir));
        old.use('/dashboard', (req, res, next) => {
          if (req.method !== 'GET' || req.path.includes('.')) return next();
          res.sendFile(path.join(dir, 'index.html'), (err) => { if (err) next(); });
        });

        const { server, base } = await listenApp(old);
        try {
          const requestUrl = `${base}/dashboard/portal/handoffs`;
          const html = await (await fetch(requestUrl)).text();
          const baseUrl = new URL(extractBaseHref(html), requestUrl);
          const resolved = new URL(extractAssetRefs(html)[0], baseUrl);
          const assetRes = await fetch(resolved);
          assert.equal(assetRes.status, 404,
            `the old behaviour must 404 here, otherwise this change fixes nothing; got ${assetRes.status}`);
          assert.match(resolved.pathname, /\/dashboard\/portal\/assets\//,
            'the old base resolved the asset under the route directory, which is the bug');
        } finally {
          server.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

describe('v1.26.44 — the served base href resolves to the mount root', { skip: needsBuild }, () => {
  // The invariant: resolved against the request URL, the emitted base must land
  // on the directory that actually holds index.html and assets/.
  const cases = [
    { route: '/dashboard/login', expected: './', why: 'one segment: the route directory already is the mount root' },
    { route: '/dashboard/portal/handoffs', expected: '../', why: 'two segments: climb one level' },
    { route: '/dashboard/preference/vault', expected: '../', why: 'two segments: climb one level' },
    { route: '/dashboard/portal/handoffs/', expected: '../../', why: 'a trailing slash makes the route itself the directory' },
  ];

  for (const { route, expected, why } of cases) {
    it(`GET ${route} serves base href "${expected}" — ${why}`, async () => {
      const { server, base } = await listenApp();
      try {
        const res = await fetch(`${base}${route}`);
        const html = await res.text();
        assert.equal(res.status, 200);
        assert.equal(extractBaseHref(html), expected);
      } finally {
        server.close();
      }
    });
  }

  it('every asset the shell references is actually reachable after resolution', async () => {
    // The end-to-end proof: resolve each asset reference the way a browser would
    // and fetch it. This is the assertion that fails today with a 404.
    const { server, base } = await listenApp();
    try {
      const requestUrl = `${base}/dashboard/portal/handoffs`;
      const html = await (await fetch(requestUrl)).text();
      const baseHref = extractBaseHref(html);
      const baseUrl = new URL(baseHref, requestUrl);

      const refs = extractAssetRefs(html);
      assert.ok(refs.length >= 2, `expected the shell to reference js and css, got ${refs.length}`);

      for (const ref of refs) {
        const resolved = new URL(ref, baseUrl);
        const assetRes = await fetch(resolved);
        assert.equal(assetRes.status, 200,
          `${ref} resolved to ${resolved.pathname} and returned ${assetRes.status}`);
      }
    } finally {
      server.close();
    }
  });

  it('the emitted base stays relative, so the reverse-proxy prefix survives', async () => {
    // nginx strips /ownmind before proxying, so Express never sees the public
    // prefix. An absolute base href could not be computed correctly here; only a
    // relative one resolves right under both mount points.
    const { server, base } = await listenApp();
    try {
      const html = await (await fetch(`${base}/dashboard/portal/handoffs`)).text();
      const baseHref = extractBaseHref(html);

      assert.ok(!baseHref.startsWith('/'),
        `base href must not be an absolute path, got "${baseHref}"`);
      assert.ok(!/^[a-z]+:/i.test(baseHref),
        `base href must not be an absolute URL, got "${baseHref}"`);

      // Applied to the public URL the browser actually requested, the same value
      // must resolve to the prefixed app root.
      assert.equal(
        new URL(baseHref, 'https://example.com/ownmind/dashboard/portal/handoffs').href,
        'https://example.com/ownmind/dashboard/',
        'must resolve to the app root with the /ownmind prefix intact');

      // And to the unprefixed root when reached directly.
      assert.equal(
        new URL(baseHref, 'http://localhost:3100/dashboard/portal/handoffs').href,
        'http://localhost:3100/dashboard/',
        'must resolve to the app root when mounted without a prefix');
    } finally {
      server.close();
    }
  });

  it('the mount root is served untouched with the on-disk "./"', async () => {
    // express.static answers /dashboard/ from disk before the fallback runs, and
    // "./" is already correct there.
    const { server, base } = await listenApp();
    try {
      const html = await (await fetch(`${base}/dashboard/`)).text();
      assert.equal(extractBaseHref(html), './');
    } finally {
      server.close();
    }
  });
});

describe('v1.26.44 — relativeBaseHref', () => {
  const table = [
    ['/', './'],
    ['/login', './'],
    ['/portal/handoffs', '../'],
    ['/portal/handoffs/', '../../'],
    ['/a/b/c/d', '../../../'],
    // Not a shape Express produces: a request to /dashboard yields req.path '/',
    // and express.static 301s it to /dashboard/ before the fallback runs. Listed
    // only to pin the defensive branch for a non-rooted or non-string input, which
    // returns the safe './'. Note './' would resolve to the mount root's *parent*
    // if this ever were reachable; no purely relative href can climb to
    // '.../dashboard/' from '.../dashboard', which is exactly why the 301 exists.
    ['', './'],
  ];

  for (const [routePath, expected] of table) {
    it(`"${routePath}" -> "${expected}"`, () => {
      assert.equal(relativeBaseHref(routePath), expected);
    });
  }

  it('counts empty segments as levels, because the URL resolver does', () => {
    // The earlier implementation collapsed these and emitted '../', which resolves
    // to /dashboard/portal/ and 404s every asset. nginx merges slashes so
    // production was shielded, but the direct localhost:3100 deployment is not.
    assert.equal(relativeBaseHref('/portal//handoffs'), '../../');
    assert.equal(relativeBaseHref('/a//b'), '../../');
    assert.equal(relativeBaseHref('//a//b'), '../../../');
  });

  it('every shape resolves to the mount root, checked against the URL resolver', () => {
    // The invariant itself, rather than the expected strings: whatever the function
    // returns must land exactly on the directory holding index.html.
    const shapes = [
      '/', '/login', '/a/b', '/a/b/', '/a/b/c/d',
      '//a//b', '/a//b', '/a//b/', '/a/b//', '///a',
      '/portal/handoffs', '/portal//handoffs',
    ];
    for (const routePath of shapes) {
      const requestUrl = `https://example.com/ownmind/dashboard${routePath}`;
      assert.equal(
        new URL(relativeBaseHref(routePath), requestUrl).pathname,
        '/ownmind/dashboard/',
        `"${routePath}" emitted "${relativeBaseHref(routePath)}", which does not land on the mount root`,
      );
    }
  });
});

describe('v1.26.44 — withBaseHref cannot silently no-op', () => {
  // The shell is a build artefact. A rewrite that depends on matching a literal
  // string would silently stop working if that string changed, and the failure
  // mode is exactly the blank page this change removes.

  it('replaces an existing base tag and leaves exactly one', () => {
    const html = '<html><head><base href="./" />\n<title>x</title></head><body></body></html>';
    const out = withBaseHref(html, '../');
    assert.match(out, /<base href="\.\.\/"/);
    assert.equal(out.match(/<base\s/gi).length, 1);
    assert.ok(!out.includes('href="./"'));
  });

  it('inserts a base tag when the shell has none', () => {
    const html = '<html><head>\n<title>x</title>\n<script src="./assets/a.js"></script></head><body></body></html>';
    const out = withBaseHref(html, '../');
    assert.equal(out.match(/<base\s/gi).length, 1);
    // The base must precede the asset references it governs.
    assert.ok(out.indexOf('<base') < out.indexOf('./assets/a.js'),
      'inserted base must come before the asset references');
  });

  it('handles a head tag carrying attributes', () => {
    const html = '<html><head lang="x"><title>t</title></head></html>';
    const out = withBaseHref(html, '../');
    assert.equal(out.match(/<base\s/gi).length, 1);
    assert.ok(out.indexOf('<base') > out.indexOf('<head'),
      'base goes inside head, not before it');
  });

  it('leaves a shell with no head untouched apart from adding one base', () => {
    const html = '<div>no head here</div>';
    const out = withBaseHref(html, '../');
    assert.equal(out.match(/<base\s/gi)?.length ?? 0, 1);
  });
});

describe('v1.26.44 — existing behaviour is preserved', () => {
  it('an asset miss under a deep route still 404s instead of returning HTML', { skip: needsBuild }, async () => {
    const { server, base } = await listenApp();
    try {
      const res = await fetch(`${base}/dashboard/portal/assets/index-nonexistent.js`);
      assert.equal(res.status, 404);
      assert.ok(!(res.headers.get('content-type') || '').includes('text/html')
        || !(await res.text()).includes('<base'),
        'a missing asset must not be answered with the SPA shell');
    } finally {
      server.close();
    }
  });

  it('the shell is served as text/html', { skip: needsBuild }, async () => {
    const { server, base } = await listenApp();
    try {
      const res = await fetch(`${base}/dashboard/portal/handoffs`);
      // Status and body matter as much as the type: Express's own 404 page is also
      // text/html, so asserting the header alone could never go red.
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /text\/html/);
      assert.match(await res.text(), /<base\s/);
    } finally {
      server.close();
    }
  });

  it('a POST to a route is not answered with the shell', { skip: needsBuild }, async () => {
    const { server, base } = await listenApp();
    try {
      const res = await fetch(`${base}/dashboard/portal/handoffs`, { method: 'POST' });
      assert.notEqual(res.status, 200);
      assert.ok(!(await res.text()).includes('<base'),
        'non-GET must fall through to normal error handling');
    } finally {
      server.close();
    }
  });

  it('a missing shell file falls through instead of becoming a 500', async () => {
    // Matches the previous res.sendFile error path: on a miss, call next().
    const probe = express();
    probe.use('/dashboard', createSpaShellHandler(
      path.join(repoRoot, 'src', 'public', 'dashboard', 'does-not-exist.html')));
    probe.use((req, res) => res.status(404).type('text/plain').send('fell through'));

    const { server, base } = await listenApp(probe);
    try {
      const res = await fetch(`${base}/dashboard/portal/handoffs`);
      assert.equal(res.status, 404);
      assert.equal(await res.text(), 'fell through');
    } finally {
      server.close();
    }
  });
});

describe('v1.26.44 — drift guards', () => {
  it('src/app.js serves the dashboard shell through the helper', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(path.join(repoRoot, 'src/app.js'), 'utf8');
    assert.match(src, /createSpaShellHandler/,
      'src/app.js must serve the shell through createSpaShellHandler, not a raw sendFile');
    assert.ok(!/sendFile\([^)]*dashboard/.test(src),
      'the old raw sendFile of the dashboard shell must be gone');
  });

  it('the built shell still carries a base tag for the rewrite to target', { skip: needsBuild }, async () => {
    const fs = await import('node:fs');
    const shell = fs.readFileSync(
      path.join(repoRoot, 'src/public/dashboard/index.html'), 'utf8');
    assert.match(shell, /<base\s[^>]*href="\.\/"/,
      'the on-disk shell must keep <base href="./"> — it is what the mount root needs');
  });

  it('the built shell still references its assets relatively', { skip: needsBuild }, async () => {
    // If vite ever emits absolute asset paths, the base rewrite becomes a no-op
    // and deep links break again in a different way.
    const fs = await import('node:fs');
    const shell = fs.readFileSync(
      path.join(repoRoot, 'src/public/dashboard/index.html'), 'utf8');
    const refs = extractAssetRefs(shell);
    assert.ok(refs.length >= 2,
      `expected relative js and css references in the shell, found ${refs.length}`);
    assert.ok(!/(?:src|href)="\/assets\//.test(shell),
      'absolute /assets/ references would ignore the base href');
  });
});
