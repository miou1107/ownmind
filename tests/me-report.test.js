/**
 * v1.17.24: User-accessible 用量報告頁（/ownmind/me/）
 *
 * 開放讓 user role 也能登入查看：
 *   - 自己活動量、版本、專案、鐵律遵守
 *   - 全團隊聚合（Q1=C user 選擇完全開放、無匿名化）
 *   - 團隊各專案統計（Q2=B 全團隊專案都看得到）
 *   - 獨立 URL /ownmind/me/（Q3=B）
 *
 * 認證：直接用 user 既有 api_key（從 MCP setup 拿到，已寫進 Claude Code settings.json）
 * 不做密碼登入流程（user role 沒 password_hash）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

test('src/routes/me.js: 必須存在（user-accessible 用量報告路由）', () => {
  assert.ok(
    existsSync(join(repoRoot, 'src', 'routes', 'me.js')),
    'src/routes/me.js 必須存在；提供 user role 看得到的個人 + 團隊用量 API'
  );
});

test('src/routes/me.js: 必須有 /profile 跟 /report 兩個 endpoint', () => {
  const meSource = readFileSync(join(repoRoot, 'src', 'routes', 'me.js'), 'utf8');
  assert.match(meSource, /router\.get\(['"]\/profile['"]/, 'GET /profile 必須存在（驗 api_key + 回身份）');
  assert.match(meSource, /router\.get\(['"]\/report['"]/, 'GET /report 必須存在（聚合用量資料）');
});

test('src/routes/me.js: endpoint 必須用 auth middleware（接受任意 role）', () => {
  const meSource = readFileSync(join(repoRoot, 'src', 'routes', 'me.js'), 'utf8');
  // 用 ../middleware/auth.js（不是 adminAuth — 否則 user role 被擋）
  assert.match(
    meSource,
    /from\s+['"]\.\.\/middleware\/auth(\.js)?['"]/,
    '必須 import 一般 auth middleware（adminAuth 會擋 user role）'
  );
  assert.doesNotMatch(
    meSource,
    /adminAuth|superAdminAuth/,
    'me.js 不能用 adminAuth — 整個重點就是讓 user role 也能進'
  );
});

test('src/routes/me.js: report 必須回 me / team / projects 三大區塊', () => {
  const meSource = readFileSync(join(repoRoot, 'src', 'routes', 'me.js'), 'utf8');
  // 確認三個 top-level key 都出現在 source（足以證明 res.json 有送）
  for (const section of ['me', 'team', 'projects']) {
    const re = new RegExp(`\\b${section}\\s*:\\s*\\{|\\b${section}\\s*:\\s*\\[|\\b${section}\\s*:\\s*team`, 'm');
    assert.ok(
      re.test(meSource) || meSource.includes(`${section}:`),
      `me.js 必須有 ${section}: 結構作為 response 鍵`
    );
  }
});

test('src/app.js: 必須掛 me 路由 + 提供 /ownmind/me/ 靜態頁', () => {
  const appSource = readFileSync(join(repoRoot, 'src', 'app.js'), 'utf8');
  assert.match(
    appSource,
    /['"]\/api\/me['"]/,
    'src/app.js 必須掛 /api/me 路由'
  );
  assert.match(
    appSource,
    /['"]\/me['"]|['"]\/ownmind\/me['"]/,
    'src/app.js 必須提供 /me 或 /ownmind/me 靜態頁路徑'
  );
});

test('src/public/me/index.html: 必須存在', () => {
  assert.ok(
    existsSync(join(repoRoot, 'src', 'public', 'me', 'index.html')),
    'src/public/me/index.html 必須存在 — user 可瀏覽的報告頁'
  );
});

test('src/public/me/index.html: 必須含 api key 輸入 + report fetch + 三大區塊', () => {
  const html = readFileSync(join(repoRoot, 'src', 'public', 'me', 'index.html'), 'utf8');
  assert.match(html, /api[_-]?key|API\s*Key/i, 'me/index.html 必須有 api key 輸入欄位（user 第一次貼 key）');
  assert.match(html, /\/api\/me\/report/, '必須 fetch /api/me/report 拿資料');
  assert.match(html, /localStorage/, '必須用 localStorage 存 api key 避免每次重貼');
  // 三大區塊（個人 / 團隊 / 專案）
  for (const word of ['個人', '團隊', '專案']) {
    assert.ok(
      html.includes(word),
      `me/index.html 必須有「${word}」段落`
    );
  }
});
