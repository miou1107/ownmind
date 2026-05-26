import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.91 — Secret 管理補完
 *
 * 背景（Vin 問：MCP 沒 delete_secret，要做嗎？修改？停用？）：
 *   現況 secret 工具不完整：
 *     - ownmind_set_secret 描述寫「儲存或更新」但 server POST 純 INSERT、重複 set 同 key 會 500
 *     - MCP 沒有 delete tool（但 server DELETE endpoint 早就有）
 *     - secret 操作沒寫 activity_log audit trail（memory 有 memory_history、secret 沒對應）
 *
 * 設計決策（Vin 跟我討論過）：
 *   ✓ POST 改 upsert：跟工具描述對齊、修現有 bug
 *   ✓ 新 ownmind_delete_secret tool：補功能 gap
 *   ✓ set/delete 寫 activity_log：補 audit（不寫 value、只記 key + 動作）
 *   ✗ 不加 disable_secret：secret 沒有「啟用 / 停用」語義、加 status 反而給錯誤安全感
 */

describe('v1.17.91 — secret.js POST 改成 upsert（ON CONFLICT DO UPDATE）', () => {
  const secretSource = fs.readFileSync(path.join(repoRoot, 'src/routes/secret.js'), 'utf8');

  it('POST / 的 INSERT 必須含 ON CONFLICT (user_id, key) DO UPDATE', () => {
    // 找 POST endpoint 的 INSERT 片段
    const m = secretSource.match(/router\.post\('\/'[\s\S]+?(?=\nrouter\.|\nexport default)/);
    assert.ok(m, '找不到 POST / handler');
    assert.match(m[0], /ON CONFLICT\s*\(\s*user_id\s*,\s*key\s*\)\s*DO UPDATE/,
      'POST / 必須是 upsert（避免重複 set 同 key 觸發 23505 unique violation）');
    assert.match(m[0], /EXCLUDED\.encrypted_value/,
      'upsert 必須更新 encrypted_value（呼叫端送新 value 時要實際更新）');
    assert.match(m[0], /updated_at\s*=\s*NOW\(\)/,
      'upsert 必須更新 updated_at（追溯最後修改時間）');
  });
});

describe('v1.17.91 — MCP 加 ownmind_delete_secret tool', () => {
  const mcpSource = fs.readFileSync(path.join(repoRoot, 'mcp/index.js'), 'utf8');

  it('tools 列表必須含 ownmind_delete_secret 定義', () => {
    // 找 tool 定義（name: "ownmind_delete_secret"）
    assert.match(mcpSource, /name:\s*["']ownmind_delete_secret["']/,
      'MCP tools 列表必須含 ownmind_delete_secret');
  });

  it('ownmind_delete_secret 必須要求 key 參數', () => {
    // 抓 ownmind_delete_secret tool 定義整段
    const m = mcpSource.match(/name:\s*["']ownmind_delete_secret["'][\s\S]+?required:\s*\[[^\]]*\]/);
    assert.ok(m, '找不到 ownmind_delete_secret tool 定義');
    assert.match(m[0], /required:\s*\[\s*["']key["']\s*\]/,
      'delete tool 必須 require key 參數');
  });

  it('switch case 必須 handle ownmind_delete_secret', () => {
    assert.match(mcpSource, /case\s+["']ownmind_delete_secret["']/,
      'MCP switch case 必須處理 ownmind_delete_secret');
  });

  it('delete handler 必須呼叫 DELETE /api/secret/:key', () => {
    // 抓 case "ownmind_delete_secret" 區塊
    const m = mcpSource.match(/case\s+["']ownmind_delete_secret["'][\s\S]+?(?=case\s+["'][a-z_]+["']|\}\s*$)/);
    assert.ok(m, '找不到 ownmind_delete_secret case');
    assert.match(m[0], /callApi\(\s*["']DELETE["']\s*,\s*`\/api\/secret\//,
      'delete handler 必須打 DELETE /api/secret/:key');
  });

  it('ownmind_delete_secret tool 描述必須警告「不可復原」', () => {
    const m = mcpSource.match(/name:\s*["']ownmind_delete_secret["'][\s\S]+?inputSchema/);
    assert.ok(m, '找不到 ownmind_delete_secret tool 區塊');
    // Either Chinese or English wording is accepted
    assert.match(m[0], /不可復原|無法復原|永久刪除|不可恢復|irreversible|cannot be undone|permanently delete/i,
      'delete tool 描述應警告刪除不可復原（避免 AI 誤刪）');
  });
});

describe('v1.17.91 — secret 操作寫 activity_log audit（不洩漏 value）', () => {
  const secretSource = fs.readFileSync(path.join(repoRoot, 'src/routes/secret.js'), 'utf8');

  it('POST / 成功時必須寫 activity_log，event 為 secret_set', () => {
    const m = secretSource.match(/router\.post\('\/'[\s\S]+?(?=\nrouter\.|\nexport default)/);
    assert.ok(m, '找不到 POST / handler');
    assert.match(m[0], /INSERT INTO activity_logs|activity_logs/,
      'POST 成功時必須寫 activity_log');
    assert.match(m[0], /['"]secret_set['"]/,
      'event 名稱為 secret_set');
  });

  it('DELETE /:key 成功時必須寫 activity_log，event 為 secret_delete', () => {
    const m = secretSource.match(/router\.delete\('\/:key'[\s\S]+?(?=\nrouter\.|\nexport default)/);
    assert.ok(m, '找不到 DELETE /:key handler');
    assert.match(m[0], /INSERT INTO activity_logs|activity_logs/,
      'DELETE 成功時必須寫 activity_log');
    assert.match(m[0], /['"]secret_delete['"]/,
      'event 名稱為 secret_delete');
  });

  it('PUT /:key 成功時必須寫 activity_log，event 為 secret_update（補 review I-1 gap）', () => {
    // Code-reviewer 抓到：v1.17.91 第一輪我只加了 POST + DELETE audit，
    // PUT /:key 也會修改 encrypted_value / description、forensic timeline 缺一塊。
    const m = secretSource.match(/router\.put\('\/:key'[\s\S]+?(?=\nrouter\.|\nexport default)/);
    assert.ok(m, '找不到 PUT /:key handler');
    assert.match(m[0], /INSERT INTO activity_logs|activity_logs/,
      'PUT 成功時必須寫 activity_log（不能只記 POST + DELETE）');
    assert.match(m[0], /['"]secret_update['"]/,
      'event 名稱為 secret_update');
  });

  it('PUT activity_log details 也不能含 value / encrypted_value（IR-002）', () => {
    const m = secretSource.match(/router\.put\('\/:key'[\s\S]+?(?=\nrouter\.|\nexport default)/);
    assert.ok(m, '找不到 PUT handler');
    const logSection = m[0].match(/INSERT INTO activity_logs[\s\S]+?\]\s*\)/);
    if (logSection) {
      assert.doesNotMatch(logSection[0], /\bvalue\b/,
        'PUT activity_log details 不該含 value');
      assert.doesNotMatch(logSection[0], /encrypted_value/,
        'PUT activity_log details 不該含 encrypted_value');
    }
  });

  it('secret_set activity_log details 絕對不能含 value 欄位（IR-002 不洩漏密碼到 log）', () => {
    const m = secretSource.match(/router\.post\('\/'[\s\S]+?(?=\nrouter\.|\nexport default)/);
    assert.ok(m, '找不到 POST / handler');
    // 抓 activity_logs INSERT 那段（含 details JSON）
    const logSection = m[0].match(/INSERT INTO activity_logs[\s\S]+?\]/);
    if (logSection) {
      assert.doesNotMatch(logSection[0], /\bvalue\b/,
        'activity_log details 絕對不能含 value（會把 plaintext secret 寫進 DB log）');
      assert.doesNotMatch(logSection[0], /encrypted_value/,
        'activity_log details 不該含 encrypted_value（log 不該重複 ciphertext）');
    }
  });

  it('secret_delete activity_log details 也不能洩漏 value（即便只刪也別記值）', () => {
    const m = secretSource.match(/router\.delete\('\/:key'[\s\S]+?(?=\nrouter\.|\nexport default)/);
    assert.ok(m, '找不到 DELETE handler');
    const logSection = m[0].match(/INSERT INTO activity_logs[\s\S]+?\]/);
    if (logSection) {
      assert.doesNotMatch(logSection[0], /\bvalue\b/,
        'delete activity_log details 不該含 value');
    }
  });
});

describe('v1.17.91 — set_secret 工具描述跟行為對齊', () => {
  const mcpSource = fs.readFileSync(path.join(repoRoot, 'mcp/index.js'), 'utf8');

  it('ownmind_set_secret 描述強調「儲存或更新」（行為實際是 upsert）', () => {
    const m = mcpSource.match(/name:\s*["']ownmind_set_secret["'][\s\S]+?inputSchema/);
    assert.ok(m, '找不到 ownmind_set_secret tool 定義');
    assert.match(m[0], /儲存或更新|upsert|create or update/i,
      'set_secret 描述要明確說「儲存或更新」（行為是 upsert）');
  });
});
