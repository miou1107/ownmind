import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.19.1 — MCP 工具描述含敏感資料警語
 *
 * 對應 openspec/changes/v1.19.1-secret-tool-routing/spec.md 場景 8
 *
 * AI 在 tools/list 階段就應該看到「含密碼／token／API key 請改用 ownmind_set_secret」
 * 警語、不需要踩到 400 才知道。
 *
 * 採 source-level regex 驗證（同 v1.19 iron-rule-tier-mcp.test.js 經驗）—
 * mcp/index.js 載入會自動連 stdio MCP server、無法直接 import、改用 regex 驗證 source。
 */

const MCP_INDEX_PATH = path.join(repoRoot, 'mcp', 'index.js');
const mcpSource = fs.readFileSync(MCP_INDEX_PATH, 'utf8');

/**
 * 從 mcp/index.js source 抓某個 tool 的 description 字串
 * 找 `name: "<toolName>"` 後接的 `description:` 內容（用 regex）
 */
function extractToolDescription(toolName) {
  // 找 name: "<toolName>" 後第一個 description（可能跨行）
  const re = new RegExp(
    `name:\\s*["']${toolName}["'][\\s\\S]*?description:\\s*((?:"[^"\\\\]*(?:\\\\.[^"\\\\]*)*"|\`[^\`]*\`)(?:\\s*\\+\\s*(?:"[^"\\\\]*(?:\\\\.[^"\\\\]*)*"|\`[^\`]*\`))*)`,
    'm'
  );
  const match = mcpSource.match(re);
  if (!match) return null;
  // 把字串 concatenation（"a" + "b"）reduce 成單一字串
  return match[1]
    .split(/\s*\+\s*/)
    .map(s => s.replace(/^["'`]|["'`]$/g, ''))
    .join('');
}

describe('v1.19.1 — ownmind_save description 含敏感資料警語', () => {
  const desc = extractToolDescription('ownmind_save');

  it('應該找到 ownmind_save 描述', () => {
    assert.ok(desc, '應該能從 mcp/index.js 抓到 ownmind_save description');
  });

  it('description 含「敏感資料」或「密碼」字串', () => {
    assert.ok(
      /敏感資料|密碼|密鑰|token|API key|sensitive|password|credential/i.test(desc),
      `description 應提到敏感資料／密碼類關鍵字、實際: "${desc}"`
    );
  });

  it('description 含「ownmind_set_secret」字串（明確指向正確工具）', () => {
    assert.ok(
      desc.includes('ownmind_set_secret'),
      `description 應明確提到 ownmind_set_secret、實際: "${desc}"`
    );
  });

  it('警語放在 description 開頭附近（前 80 字內）', () => {
    const firstChunk = desc.slice(0, 80);
    assert.ok(
      /敏感|密碼|set_secret|ownmind_set_secret|sensitive|password|credential|secret/i.test(firstChunk),
      `警語應該在前 80 字內、實際前段: "${firstChunk}"`
    );
  });
});

describe('v1.19.1 — ownmind_update description 含敏感資料警語', () => {
  const desc = extractToolDescription('ownmind_update');

  it('應該找到 ownmind_update 描述', () => {
    assert.ok(desc);
  });

  it('description 含「敏感資料」或「密碼」字串', () => {
    assert.ok(
      /敏感資料|密碼|密鑰|token|API key|sensitive|password|credential/i.test(desc),
      `description 應提到敏感資料、實際: "${desc}"`
    );
  });

  it('description 含「ownmind_set_secret」字串', () => {
    assert.ok(desc.includes('ownmind_set_secret'));
  });

  it('警語放在 description 開頭附近（前 80 字內）', () => {
    const firstChunk = desc.slice(0, 80);
    assert.ok(/敏感|密碼|set_secret|ownmind_set_secret|sensitive|password|credential|secret/i.test(firstChunk));
  });
});

describe('v1.19.1 — ownmind_set_secret description 不重複自己（避免循環）', () => {
  const desc = extractToolDescription('ownmind_set_secret');

  it('應該找到 ownmind_set_secret 描述', () => {
    assert.ok(desc);
  });

  it('description 不含「請改用 ownmind_set_secret」這種循環提示', () => {
    assert.ok(
      !desc.includes('請改用 ownmind_set_secret') &&
      !/use\s+ownmind_set_secret\s+instead/i.test(desc),
      `set_secret 自己的描述不該叫人「改用 set_secret」、實際: "${desc}"`
    );
  });
});
