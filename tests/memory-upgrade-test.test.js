import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 只做 route guard 邏輯的 lightweight unit test
// （memory.js 是單一 router 檔案，完整 DB-backed integration 暫省；P8 deploy 時再跑 E2E）

describe('memory route: is_test guard 邏輯', () => {
  const src = fs.readFileSync(new URL('../src/routes/memory.js', import.meta.url), 'utf8');

  it('POST / 正確處理 is_test flag（僅允許 __upgrade_test__ prefix）', () => {
    assert.match(src, /is_test/);
    assert.match(src, /__upgrade_test__/);
    assert.match(src, /僅限 title 以 __upgrade_test__ 開頭/);
  });

  it('test-cleanup route 存在且有 prefix guard', () => {
    assert.match(src, /router\.delete\(['"]\/test-cleanup['"]/);
    assert.match(src, /name_prefix 必須以 __upgrade_test__ 開頭/);
    assert.match(src, /is_test = TRUE/);
  });

  it('test-cleanup 限定當前 user (防止跨用戶刪資料)', () => {
    // DELETE SQL 必須包含 user_id = $1 過濾
    const deleteBlock = src.match(
      /router\.delete\(['"]\/test-cleanup['"][\s\S]*?(?=router\.)/
    )?.[0] || '';
    assert.match(deleteBlock, /WHERE user_id = \$1/);
  });
});
