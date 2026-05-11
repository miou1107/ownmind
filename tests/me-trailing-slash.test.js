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
 * Vin 回報：https://kkvin.com/ownmind/me 連不上、必須打 /ownmind/me/。
 *
 * 根因：Express `app.use('/me', express.static(...))` 對 mount path 本身不
 * 自動加 trailing slash redirect — 只對「目錄請求」做。
 * `/me`（沒尾斜線）會直接 404、`/me/` 才會 hit index.html。
 *
 * 修法：在 static mount 前加 `app.get('/me', (req,res) => res.redirect(301, 'me/'))`。
 * 用相對路徑 'me/' 避免 nginx reverse proxy strip /ownmind prefix 後 Location
 * 變絕對路徑的問題（相對 'me/' 對當前 URL /ownmind/me 來說瀏覽器會拼出 /ownmind/me/）。
 */

describe('v1.17.88 — /me 沒 trailing slash 自動 301 redirect', () => {
  // Mini Express app 模擬 src/app.js 結構
  function makeApp() {
    const app = express();
    app.disable('x-powered-by');
    // 鏡像 src/app.js 的 mount 順序
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

  it('GET /me 回 301 + Location: me/（相對路徑）', async () => {
    const app = makeApp();
    const r = await getResponse(app, '/me');
    assert.equal(r.status, 301, '應該 301 永久重定向');
    assert.equal(r.location, 'me/', 'Location 必須是相對路徑 me/，避免 nginx prefix 問題');
  });

  it('GET /me/ 直接回 200（serve index.html）', async () => {
    const app = makeApp();
    const r = await getResponse(app, '/me/');
    assert.equal(r.status, 200, '/me/ 應該直接 200 serve index.html');
  });

  it('source code 含 conditional trailing slash redirect', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(path.join(repoRoot, 'src/app.js'), 'utf8');
    assert.match(src,
      /app\.get\(['"]\/me['"][\s\S]{0,300}endsWith\(['"]\/['"]\)[\s\S]{0,200}redirect\(301[\s\S]{0,20}['"]me\/['"]/,
      'src/app.js 必須有條件式 GET /me → 已有 / 就 next、沒有就 301 me/');
  });
});
