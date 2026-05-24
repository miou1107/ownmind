import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(__dirname, '..', 'src', 'public', 'index.html');
const html = readFileSync(htmlPath, 'utf8');

/**
 * v1.19.16 hotfix：admin HTML 內嵌 JS 不能有「同函式內 const 重複宣告」、
 * 否則整個 script 解析失敗、所有函式（含 login）都拿不到 → 後台登不進去。
 *
 * 觸發來源：v1.19.0 release(commit 5ffc646) 引入鐵律 tier 升級助手時、
 * iruUpdateTier 函式裡 `const cached` 出現兩次（1926 + 1948 行）、是
 * JavaScript 規範明確的 SyntaxError。瀏覽器快取讓部分使用者一直沒爆、
 * 直到 v1.19.14 / v1.19.15 部署後 reload 才被發現。
 *
 * 用文字檢查：抓 iruUpdateTier 函式區塊裡 `const cached` 出現次數應該 ≤ 1。
 */

test('iruUpdateTier 函式內 const cached 不重複宣告', () => {
  // 抓 iruUpdateTier 函式整段（從宣告到下一個 async function / function 之間）
  const match = html.match(
    /async function iruUpdateTier\([^)]*\)\s*\{([\s\S]*?)^\s{2}\}/m
  );
  assert.ok(match, '找不到 iruUpdateTier 函式');

  const body = match[1];
  const occurrences = (body.match(/\bconst\s+cached\b/g) || []).length;
  assert.equal(
    occurrences,
    1,
    `iruUpdateTier 內 const cached 應該只宣告 1 次、實際 ${occurrences} 次（重複會造成 SyntaxError、admin login 壞掉）`
  );
});

// 註：之前嘗試做「全函式廣義檢查」但 const 在不同 block scope 內同名合法、
// 廣義檢查會誤報很多其實合法的（例如 if/else 兩 block 各有 const t）、
// 留 iruUpdateTier 這條精確檢查就夠 cover 這次的真 bug。未來若有別處
// 重複宣告再個別加 case。
