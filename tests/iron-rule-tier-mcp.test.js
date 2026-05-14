import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * v1.19 — mcp/index.js source-level 驗證 tier 欄位整合
 *
 * mcp/index.js 載入時會自動連接 stdio MCP server，無法在測試中 import。
 * 採用 source-level 驗證：讀檔 + regex 驗證 tier 出現在合適位置。
 *
 * 這只是品質保險：避免有人重構 mcp/index.js 時意外移除 tier 整合。
 * 完整端對端測試靠後續 B 階段的 server API 整合測試覆蓋。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_INDEX_PATH = path.join(__dirname, '..', 'mcp', 'index.js');
const MCP_SOURCE = fs.readFileSync(MCP_INDEX_PATH, 'utf8');

function extractToolBlock(toolName) {
  const startIdx = MCP_SOURCE.indexOf(`name: "${toolName}"`);
  assert.ok(startIdx > 0, `找不到 tool "${toolName}" 的定義`);
  // 簡單切片：從這個 tool 開始往後找下一個 name: 或 ];
  const rest = MCP_SOURCE.slice(startIdx);
  const nextNameIdx = rest.indexOf('\n    name: "', 5);
  const nextEndIdx = rest.indexOf('\n];');
  const endIdx = (nextNameIdx === -1 || (nextEndIdx !== -1 && nextEndIdx < nextNameIdx))
    ? nextEndIdx : nextNameIdx;
  return rest.slice(0, endIdx > 0 ? endIdx : rest.length);
}

function extractCaseBlock(toolName) {
  const startIdx = MCP_SOURCE.indexOf(`case "${toolName}":`);
  assert.ok(startIdx > 0, `找不到 case "${toolName}" 的 handler`);
  const rest = MCP_SOURCE.slice(startIdx);
  // 切到下一個 case 或 } 結尾
  const nextCaseIdx = rest.indexOf('\n    case "', 5);
  return rest.slice(0, nextCaseIdx > 0 ? nextCaseIdx : 3000);
}

describe('v1.19 — MCP tier 整合', () => {
  describe('ownmind_save schema', () => {
    const saveBlock = extractToolBlock('ownmind_save');

    it('inputSchema 含 tier 欄位', () => {
      assert.match(saveBlock, /tier:\s*\{/);
    });

    it('tier 欄位列出三個合法 enum 值', () => {
      assert.match(saveBlock, /tier:[\s\S]*?enum:[\s\S]*?critical/);
      assert.match(saveBlock, /tier:[\s\S]*?enum:[\s\S]*?default/);
      assert.match(saveBlock, /tier:[\s\S]*?enum:[\s\S]*?advisory/);
    });

    it('tier 欄位有描述、提到 critical / default / advisory 用途', () => {
      const tierSchema = saveBlock.slice(saveBlock.indexOf('tier:'));
      assert.match(tierSchema, /critical/);
      assert.match(tierSchema, /default/);
      assert.match(tierSchema, /advisory/);
    });
  });

  describe('ownmind_update schema', () => {
    const updateBlock = extractToolBlock('ownmind_update');

    it('inputSchema 含 tier 欄位', () => {
      assert.match(updateBlock, /tier:\s*\{/);
    });

    it('tier 欄位列出三個合法 enum 值', () => {
      assert.match(updateBlock, /tier:[\s\S]*?enum:[\s\S]*?critical/);
      assert.match(updateBlock, /tier:[\s\S]*?enum:[\s\S]*?default/);
      assert.match(updateBlock, /tier:[\s\S]*?enum:[\s\S]*?advisory/);
    });
  });

  describe('ownmind_save case handler', () => {
    const saveCase = extractCaseBlock('ownmind_save');

    it('把 args.tier 傳到 body.tier（有帶才傳）', () => {
      assert.match(saveCase, /if\s*\(\s*args\.tier\s*!==\s*undefined\s*\)\s*body\.tier\s*=\s*args\.tier/);
    });
  });

  describe('ownmind_update case handler', () => {
    const updateCase = extractCaseBlock('ownmind_update');

    it('把 args.tier 傳到 body.tier（有帶才傳）', () => {
      assert.match(updateCase, /if\s*\(\s*args\.tier\s*!==\s*undefined\s*\)\s*body\.tier\s*=\s*args\.tier/);
    });
  });
});
