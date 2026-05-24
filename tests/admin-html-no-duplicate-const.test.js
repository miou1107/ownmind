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

// ============================================================
// v1.19.17 hotfix：modal-overlay 顯示用 .active class、不是 .show
// ============================================================
// 原因：CSS 規則是 `.modal-overlay.active { display: flex; }`、所以
// classList 操作必須用 'active'。若用 'show' modal 永遠不顯示、
// 「查看」「審查」等按鈕點了沒反應、UX 死掉。

test('modal classList 操作只能用 active、不能用 show', () => {
  // 既有 CSS 規則：.modal-overlay.active 才顯示
  assert.match(
    html,
    /\.modal-overlay\.active\s*\{\s*display:\s*flex/,
    'CSS 應該定義 .modal-overlay.active 才會顯示'
  );

  // 不該有任何 classList.add('show') / .remove('show')（會打到死的 modal）
  const wrongAdd = (html.match(/classList\.add\(\s*['"]show['"]\s*\)/g) || []).length;
  const wrongRemove = (html.match(/classList\.remove\(\s*['"]show['"]\s*\)/g) || []).length;
  assert.equal(
    wrongAdd + wrongRemove,
    0,
    `發現 classList.add/remove('show') 共 ${wrongAdd + wrongRemove} 處、應該全部改成 'active'（因為 CSS 規則用的是 .active）`
  );
});
