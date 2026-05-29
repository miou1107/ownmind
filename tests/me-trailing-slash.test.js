import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.88 — /me trailing slash redirect
 *
 * Vin reported: https://example.com/ownmind/me does not load; you must hit /ownmind/me/.
 *
 * Root cause: Express `app.use('/me', express.static(...))` does not auto-add a
 * trailing slash redirect for the mount path itself — only for "directory requests".
 * `/me` (no trailing slash) just 404s; only `/me/` hits index.html.
 *
 * Fix: before the static mount add `app.get('/me', (req,res) => res.redirect(301, 'me/'))`.
 * Use the relative path 'me/' to avoid the problem where, after the nginx reverse proxy
 * strips the /ownmind prefix, the Location becomes an absolute path (relative 'me/' against
 * the current URL /ownmind/me makes the browser resolve to /ownmind/me/).
 */

describe('v1.17.88 — /me without trailing slash auto 301 redirect', () => {
  // Mini Express app mirroring the src/app.js structure
  function makeApp() {
    const app = express();
    app.disable('x-powered-by');
    // Mirror the mount order of src/app.js
    app.get('/me', (req, res, next) => {
      if (req.originalUrl.endsWith('/')) return next();
      res.redirect(301, 'me/');
    });
    app.use('/me', express.static(path.join(repoRoot, 'src/public/me')));
    return app;
  }

  async function getResponse(app, urlPath) {
    return new Promise((resolve) => {
      const srv = app.listen(0, async () => {
        const port = srv.address().port;
        const r = await fetch(`http://127.0.0.1:${port}${urlPath}`, { redirect: 'manual' });
        srv.close();
        resolve({ status: r.status, location: r.headers.get('location') });
      });
    });
  }

  it('GET /me returns 301 + Location: me/ (relative path)', async () => {
    const app = makeApp();
    const r = await getResponse(app, '/me');
    assert.equal(r.status, 301, '應該 301 永久重定向');
    assert.equal(r.location, 'me/', 'Location 必須是相對路徑 me/，避免 nginx prefix 問題');
  });

  it('GET /me/ returns 200 directly (serves index.html)', async () => {
    const app = makeApp();
    const r = await getResponse(app, '/me/');
    assert.equal(r.status, 200, '/me/ 應該直接 200 serve index.html');
  });

  it('source code contains a conditional trailing slash redirect', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(path.join(repoRoot, 'src/app.js'), 'utf8');
    assert.match(src,
      /app\.get\(['"]\/me['"][\s\S]{0,300}endsWith\(['"]\/['"]\)[\s\S]{0,200}redirect\(301[\s\S]{0,20}['"]me\/['"]/,
      'src/app.js 必須有條件式 GET /me → 已有 / 就 next、沒有就 301 me/');
  });
});
