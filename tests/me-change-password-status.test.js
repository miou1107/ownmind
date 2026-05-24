import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

/**
 * v1.20.1 — me.js POST /change-password 舊密碼錯誤必須回 400、不能回 401
 *
 * 背景：v1.20.1 步驟 3.10 守門員上線後、client.js 對 401 一律清 api_key +
 * 廣播 ownmind:auth-expired event、App.jsx 自動 navigate /login。
 *
 * 但 me.js POST /change-password 第 89 行原本對「舊密碼錯誤」也回 401、
 * 結果 mustChange 用戶在 SecurityPage 打錯舊密碼會立刻被踢回 /login、
 * 完全破壞改密流程的 UX。
 *
 * 修法：把舊密錯誤改回 400（這條已經在 router.use(auth) 之後、token 本來就有效）
 * 401 的語義保留給「身份完全失效」、跟改密失敗區分開。
 */

describe('v1.20.1 — POST /change-password 舊密錯誤狀態碼', () => {
  const meSource = readFileSync(join(repoRoot, 'src/routes/me.js'), 'utf8');

  // 抓 change-password handler 整段
  const handlerMatch = meSource.match(
    /router\.post\(['"]\/change-password['"][\s\S]+?(?=\n(?:router\.|export default))/
  );

  it('change-password handler 必須存在', () => {
    assert.ok(handlerMatch, '找不到 POST /change-password handler');
  });

  it('handler 內不能有任何 status(401) 呼叫', () => {
    assert.ok(handlerMatch);
    // change-password 在 router.use(auth) 之後、token 已被 middleware 驗過
    // 處理階段任何錯誤都不該再回 401（避免 client.js 401 burst handler 誤判）
    assert.doesNotMatch(handlerMatch[0], /status\(401\)/,
      'change-password handler 整段不能有 status(401)；401 會被 client.js 視為 token 過期、踢用戶回 /login');
  });

  it('「舊密碼錯誤」回應必須是 400', () => {
    assert.ok(handlerMatch);
    // 找 '舊密碼錯誤' 字串前面 80 字內最近的 status(N) call
    // 用 reverse match 抓最後一個 status 在 '舊密碼錯誤' 前
    const m = handlerMatch[0].match(/status\((\d+)\)[\s\S]{0,80}?舊密碼錯誤/);
    assert.ok(m, '找不到回應「舊密碼錯誤」的 status call');
    assert.equal(m[1], '400',
      '舊密錯誤必須回 400、語義是「user input 錯」、跟「token 過期」(401) 區分開');
  });
});
