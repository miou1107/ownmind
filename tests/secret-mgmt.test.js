import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.91 — Secret management completion
 *
 * Background (Vin asked: MCP has no delete_secret — should we add one? modify? disable?):
 *   The current secret tooling is incomplete:
 *     - ownmind_set_secret is described as "save or update" but the server POST is INSERT-only;
 *       calling set on an existing key 500s.
 *     - MCP has no delete tool (though the server DELETE endpoint has existed for a while).
 *     - Secret operations leave no activity_log audit trail (memory has memory_history; secret has nothing).
 *
 * Design decisions (Vin and I discussed):
 *   ✓ POST becomes upsert: aligns with the tool description and fixes the existing bug.
 *   ✓ New ownmind_delete_secret tool: fills the functional gap.
 *   ✓ set/delete write activity_log: provide audit (no value; only key + action).
 *   ✗ Do not add disable_secret: secrets have no "enabled / disabled" semantics; adding a status
 *     would give a false sense of safety.
 */

describe('v1.17.91 — secret.js POST becomes upsert (ON CONFLICT DO UPDATE)', () => {
  const secretSource = fs.readFileSync(path.join(repoRoot, 'src/routes/secret.js'), 'utf8');

  it('POST / INSERT must include ON CONFLICT (user_id, key) DO UPDATE', () => {
    // Find the POST endpoint INSERT fragment.
    const m = secretSource.match(/router\.post\('\/'[\s\S]+?(?=\nrouter\.|\nexport default)/);
    assert.ok(m, 'POST / handler not found');
    assert.match(m[0], /ON CONFLICT\s*\(\s*user_id\s*,\s*key\s*\)\s*DO UPDATE/,
      'POST / must be an upsert (otherwise setting the same key twice triggers 23505 unique violation)');
    assert.match(m[0], /EXCLUDED\.encrypted_value/,
      'upsert must update encrypted_value (so callers that send a new value actually update it)');
    assert.match(m[0], /updated_at\s*=\s*NOW\(\)/,
      'upsert must update updated_at (track the last modification time)');
  });
});

describe('v1.17.91 — MCP adds ownmind_delete_secret tool', () => {
  const mcpSource = fs.readFileSync(path.join(repoRoot, 'mcp/index.js'), 'utf8');

  it('tools list must contain the ownmind_delete_secret definition', () => {
    // Find the tool definition (name: "ownmind_delete_secret").
    assert.match(mcpSource, /name:\s*["']ownmind_delete_secret["']/,
      'MCP tools list must contain ownmind_delete_secret');
  });

  it('ownmind_delete_secret must require the key parameter', () => {
    // Grab the entire ownmind_delete_secret tool definition.
    const m = mcpSource.match(/name:\s*["']ownmind_delete_secret["'][\s\S]+?required:\s*\[[^\]]*\]/);
    assert.ok(m, 'ownmind_delete_secret tool definition not found');
    assert.match(m[0], /required:\s*\[\s*["']key["']\s*\]/,
      'delete tool must require the key parameter');
  });

  it('switch case must handle ownmind_delete_secret', () => {
    assert.match(mcpSource, /case\s+["']ownmind_delete_secret["']/,
      'MCP switch case must handle ownmind_delete_secret');
  });

  it('delete handler must call DELETE /api/secret/:key', () => {
    // Grab the case "ownmind_delete_secret" block.
    const m = mcpSource.match(/case\s+["']ownmind_delete_secret["'][\s\S]+?(?=case\s+["'][a-z_]+["']|\}\s*$)/);
    assert.ok(m, 'ownmind_delete_secret case not found');
    assert.match(m[0], /callApi\(\s*["']DELETE["']\s*,\s*`\/api\/secret\//,
      'delete handler must hit DELETE /api/secret/:key');
  });

  it('ownmind_delete_secret tool description must warn that deletion is irreversible', () => {
    const m = mcpSource.match(/name:\s*["']ownmind_delete_secret["'][\s\S]+?inputSchema/);
    assert.ok(m, 'ownmind_delete_secret tool block not found');
    // Either Chinese or English wording is accepted
    assert.match(m[0], /不可復原|無法復原|永久刪除|不可恢復|irreversible|cannot be undone|permanently delete/i,
      'delete tool description should warn that deletion is irreversible (avoid the AI deleting by mistake)');
  });
});

describe('v1.17.91 — secret operations write activity_log audit (without leaking value)', () => {
  const secretSource = fs.readFileSync(path.join(repoRoot, 'src/routes/secret.js'), 'utf8');

  it('POST / on success must write an activity_log with event=secret_set', () => {
    const m = secretSource.match(/router\.post\('\/'[\s\S]+?(?=\nrouter\.|\nexport default)/);
    assert.ok(m, 'POST / handler not found');
    assert.match(m[0], /INSERT INTO activity_logs|activity_logs/,
      'POST on success must write an activity_log');
    assert.match(m[0], /['"]secret_set['"]/,
      'event name should be secret_set');
  });

  it('DELETE /:key on success must write an activity_log with event=secret_delete', () => {
    const m = secretSource.match(/router\.delete\('\/:key'[\s\S]+?(?=\nrouter\.|\nexport default)/);
    assert.ok(m, 'DELETE /:key handler not found');
    assert.match(m[0], /INSERT INTO activity_logs|activity_logs/,
      'DELETE on success must write an activity_log');
    assert.match(m[0], /['"]secret_delete['"]/,
      'event name should be secret_delete');
  });

  it('PUT /:key on success must write an activity_log with event=secret_update (closes review I-1 gap)', () => {
    // Code-reviewer caught it: in the first round of v1.17.91 I only added POST + DELETE audit;
    // PUT /:key also modifies encrypted_value / description, leaving a gap in the forensic timeline.
    const m = secretSource.match(/router\.put\('\/:key'[\s\S]+?(?=\nrouter\.|\nexport default)/);
    assert.ok(m, 'PUT /:key handler not found');
    assert.match(m[0], /INSERT INTO activity_logs|activity_logs/,
      'PUT on success must write an activity_log (POST + DELETE alone is insufficient)');
    assert.match(m[0], /['"]secret_update['"]/,
      'event name should be secret_update');
  });

  it('PUT activity_log details must not contain value / encrypted_value (IR-002)', () => {
    const m = secretSource.match(/router\.put\('\/:key'[\s\S]+?(?=\nrouter\.|\nexport default)/);
    assert.ok(m, 'PUT handler not found');
    const logSection = m[0].match(/INSERT INTO activity_logs[\s\S]+?\]\s*\)/);
    if (logSection) {
      assert.doesNotMatch(logSection[0], /\bvalue\b/,
        'PUT activity_log details must not contain value');
      assert.doesNotMatch(logSection[0], /encrypted_value/,
        'PUT activity_log details must not contain encrypted_value');
    }
  });

  it('secret_set activity_log details must never contain a value field (IR-002 — do not leak passwords to logs)', () => {
    const m = secretSource.match(/router\.post\('\/'[\s\S]+?(?=\nrouter\.|\nexport default)/);
    assert.ok(m, 'POST / handler not found');
    // Grab the activity_logs INSERT block (including the details JSON).
    const logSection = m[0].match(/INSERT INTO activity_logs[\s\S]+?\]/);
    if (logSection) {
      assert.doesNotMatch(logSection[0], /\bvalue\b/,
        'activity_log details must never contain value (would write plaintext secrets into DB logs)');
      assert.doesNotMatch(logSection[0], /encrypted_value/,
        'activity_log details must not contain encrypted_value (logs should not duplicate ciphertext)');
    }
  });

  it('secret_delete activity_log details must not leak value (even on delete, do not log values)', () => {
    const m = secretSource.match(/router\.delete\('\/:key'[\s\S]+?(?=\nrouter\.|\nexport default)/);
    assert.ok(m, 'DELETE handler not found');
    const logSection = m[0].match(/INSERT INTO activity_logs[\s\S]+?\]/);
    if (logSection) {
      assert.doesNotMatch(logSection[0], /\bvalue\b/,
        'delete activity_log details must not contain value');
    }
  });
});

describe('v1.17.91 — set_secret tool description aligns with behavior', () => {
  const mcpSource = fs.readFileSync(path.join(repoRoot, 'mcp/index.js'), 'utf8');

  it('ownmind_set_secret description emphasizes "save or update" (actual behavior is upsert)', () => {
    const m = mcpSource.match(/name:\s*["']ownmind_set_secret["'][\s\S]+?inputSchema/);
    assert.ok(m, 'ownmind_set_secret tool definition not found');
    assert.match(m[0], /儲存或更新|upsert|create or update/i,
      'set_secret description should clearly say "save or update" (behavior is upsert)');
  });
});
