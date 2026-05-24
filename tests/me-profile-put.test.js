import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.20.1 — 補 PUT /api/me/profile endpoint
 *
 * 背景：v1.17.24 加了 GET /api/me/profile 讓 user 看自己資料、但沒對應的 PUT。
 * Dashboard 個人版 Preference > 個人資料頁要能改 name、所以 v1.20.1 補上。
 *
 * 設計決策：
 *   - 只允許改 name；email / role 不能 user 自己改（admin / super_admin 才能改 role）
 *   - name trim 後不能空、長度 1-100
 *   - 回傳跟 GET /profile 同 shape，方便 client 直接覆蓋 state
 */

describe('v1.20.1 — PUT /api/me/profile（個人資料修改）', () => {
  const meSource = fs.readFileSync(path.join(repoRoot, 'src/routes/me.js'), 'utf8');

  // 抓 PUT /profile handler 整段（從 router.put('/profile' 到下一個 router. 或 export）
  const putHandlerMatch = meSource.match(
    /router\.put\(['"]\/profile['"][\s\S]+?(?=\n(?:router\.|export default))/
  );

  it('me.js 必須有 PUT /profile route', () => {
    assert.match(meSource, /router\.put\(['"]\/profile['"]/,
      'PUT /profile 必須存在');
  });

  it('PUT /profile handler 必須在 router.use(auth) 之後（需 Bearer 驗證）', () => {
    const authIdx = meSource.indexOf('router.use(auth)');
    const putIdx = meSource.search(/router\.put\(['"]\/profile['"]/);
    assert.ok(authIdx > 0, '找不到 router.use(auth)');
    assert.ok(putIdx > authIdx,
      'PUT /profile 必須在 router.use(auth) 後、才會被 auth middleware 擋');
  });

  it('PUT handler 必須 trim name 後再驗', () => {
    assert.ok(putHandlerMatch, '找不到 PUT /profile handler 區塊');
    assert.match(putHandlerMatch[0], /\.trim\(\)/,
      'name 必須 trim 後再驗（避免純空白通過）');
  });

  it('PUT handler 必須擋空 name（400）', () => {
    assert.ok(putHandlerMatch);
    // 驗有 length check 跟 400 response
    assert.match(putHandlerMatch[0], /status\(400\)/,
      'name 不合法時必須回 400');
  });

  it('PUT handler 必須做 name 長度上限檢查（≤ 100）', () => {
    assert.ok(putHandlerMatch);
    assert.match(putHandlerMatch[0], /100/,
      'name 長度上限 100、避免 DB column 撐爆或 UI 排版炸');
  });

  it('PUT handler 必須只 UPDATE name 欄位、不能動 email / role', () => {
    assert.ok(putHandlerMatch);
    // 驗 SQL 含 SET name = ...
    assert.match(putHandlerMatch[0], /UPDATE\s+users\s+SET\s+name\s*=/i,
      'UPDATE 只能改 name 欄位');
    // 確保 SQL 內沒寫 SET email 或 SET role（即使 body 帶這兩個也忽略）
    assert.doesNotMatch(putHandlerMatch[0], /SET[^;]*\bemail\s*=/i,
      'UPDATE 不能含 email = ...');
    assert.doesNotMatch(putHandlerMatch[0], /SET[^;]*\brole\s*=/i,
      'UPDATE 不能含 role = ...');
  });

  it('PUT handler 必須用 req.user.id 而非從 body 取 id（避免越權改別人）', () => {
    assert.ok(putHandlerMatch);
    assert.match(putHandlerMatch[0], /req\.user\.id/,
      'WHERE 子句必須鎖 req.user.id、不能讓 caller 指定 id');
  });

  it('PUT handler 回應 shape 必須跟 GET /profile 一致', () => {
    assert.ok(putHandlerMatch);
    // GET /profile 回 { id, name, email, role, created_at, must_change_password }
    assert.match(putHandlerMatch[0], /res\.json\(/,
      'PUT 必須 res.json(...) 回更新後資料');
    assert.match(putHandlerMatch[0], /name/, 'response 必須含 name');
    assert.match(putHandlerMatch[0], /email/, 'response 必須含 email');
    assert.match(putHandlerMatch[0], /role/, 'response 必須含 role');
  });

  it('PUT handler 必須有 try/catch + logger.error（IR-038 觀測性）', () => {
    assert.ok(putHandlerMatch);
    assert.match(putHandlerMatch[0], /try\s*\{/, 'PUT handler 必須包 try/catch');
    assert.match(putHandlerMatch[0], /logger\.error/,
      '失敗時必須 logger.error、不能 silent fail');
    assert.match(putHandlerMatch[0], /status\(500\)/,
      'catch 內必須回 500');
  });

  it('logger.error 必須帶 stack（跟 me/report 等其他 handler 一致）', () => {
    assert.ok(putHandlerMatch);
    // stack 對 debug 必要（其他 handler 如 me/report 都帶）
    assert.match(putHandlerMatch[0], /stack:\s*err\.stack/,
      'logger.error 必須包 stack: err.stack，跟既有 handler 一致');
  });

  it('UPDATE 必須檢查 rowCount === 0 → 404（race condition：user 被刪）', () => {
    assert.ok(putHandlerMatch);
    // 防 silent fail：token 仍有效但 user row 已被 admin 刪掉時、不能假裝 200
    assert.match(putHandlerMatch[0], /rowCount\s*===\s*0/,
      'UPDATE 後必須檢查 rowCount === 0');
    assert.match(putHandlerMatch[0], /status\(404\)/,
      'rowCount === 0 時必須回 404');
  });
});
