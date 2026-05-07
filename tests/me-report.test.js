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

test('src/routes/me.js: 必須有 /profile / /report / /login / /change-password endpoint', () => {
  const meSource = readFileSync(join(repoRoot, 'src', 'routes', 'me.js'), 'utf8');
  assert.match(meSource, /router\.get\(['"]\/profile['"]/, 'GET /profile 必須存在');
  assert.match(meSource, /router\.get\(['"]\/report['"]/, 'GET /report 必須存在');
  assert.match(meSource, /router\.post\(['"]\/login['"]/, 'POST /login（v1.17.25+ email+password）');
  assert.match(meSource, /router\.post\(['"]\/change-password['"]/, 'POST /change-password 必須存在');
});

test('src/routes/me.js: /login 必須用 bcrypt.compare 驗密碼', () => {
  const meSource = readFileSync(join(repoRoot, 'src', 'routes', 'me.js'), 'utf8');
  assert.match(meSource, /bcrypt\.compare/, '/login 必須用 bcrypt.compare 驗 password_hash');
});

test('src/routes/me.js: /change-password 必須清掉 must_change_password 旗標', () => {
  const meSource = readFileSync(join(repoRoot, 'src', 'routes', 'me.js'), 'utf8');
  assert.match(
    meSource,
    /must_change_password\s*=\s*FALSE/,
    '/change-password 成功後必須 SET must_change_password = FALSE'
  );
});

test('src/jobs/seed-default-passwords.js: 必須存在', () => {
  assert.ok(
    existsSync(join(repoRoot, 'src', 'jobs', 'seed-default-passwords.js')),
    'seed-default-passwords.js 必須存在 — server boot 時補預設密碼'
  );
});

test('src/jobs/seed-default-passwords.js: 必須是 idempotent（只 UPDATE password_hash IS NULL）', () => {
  const src = readFileSync(join(repoRoot, 'src', 'jobs', 'seed-default-passwords.js'), 'utf8');
  assert.match(src, /password_hash\s+IS\s+NULL/i, 'seed 必須只動 password_hash IS NULL 的 row');
  assert.match(src, /must_change_password\s*=\s*TRUE/, '補預設密碼時必須一併設 must_change_password = TRUE');
});

test('db/010_user_password_login.sql: 必須加 must_change_password 欄位', () => {
  const sqlPath = join(repoRoot, 'db', '010_user_password_login.sql');
  assert.ok(existsSync(sqlPath), 'migration 010 必須存在');
  const sql = readFileSync(sqlPath, 'utf8');
  assert.match(sql, /must_change_password\s+BOOLEAN/i, 'migration 必須加 must_change_password 欄位');
});

test('admin.js POST /users: user role 無 password 時自動套預設密碼 + must_change_password', () => {
  // v1.17.26: 新增 user 時，若無 password（admin 不想自己設），server 自動套
  // Password42760988 + must_change_password=TRUE，跟 seed-default-passwords 行為一致
  const adminSrc = readFileSync(join(repoRoot, 'src', 'routes', 'admin.js'), 'utf8');
  // 必須有 DEFAULT_USER_PASSWORD 常數或 'Password42760988' literal
  assert.ok(
    adminSrc.includes('Password42760988') || /DEFAULT_USER_PASSWORD/.test(adminSrc),
    'admin.js 必須引用預設密碼 Password42760988'
  );
  // INSERT users 必須能寫入 must_change_password 欄位
  assert.match(
    adminSrc,
    /INSERT INTO users[\s\S]{0,400}must_change_password/,
    'POST /users 的 INSERT 必須帶 must_change_password 欄位'
  );
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

test('src/public/me/index.html: email/password 登入 + 強制改密碼 + 三大區塊', () => {
  const html = readFileSync(join(repoRoot, 'src', 'public', 'me', 'index.html'), 'utf8');
  // v1.17.25 改成 email + password 登入
  assert.match(html, /type="email"/, '必須有 email 輸入欄');
  assert.match(html, /type="password"/, '必須有 password 輸入欄');
  assert.match(html, /\/api\/me\/login/, '必須打 /api/me/login（POST email/password）');
  assert.match(html, /\/api\/me\/change-password/, '必須有 /change-password 呼叫（強制改密碼）');
  assert.match(html, /must_change_password/, '必須處理 must_change_password 旗標分支');
  assert.match(html, /\/api\/me\/report/, '必須 fetch /api/me/report 拿資料');
  assert.match(html, /localStorage/, '必須用 localStorage 存 session');
  for (const word of ['個人', '團隊', '專案']) {
    assert.ok(html.includes(word), `me/index.html 必須有「${word}」段落`);
  }
});
