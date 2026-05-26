import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.84 — Windows file-lock detection during upgrade (vin-windows-test, round 7)
 *
 * Root cause (Windows-specific):
 *   The OwnMind MCP server (cmd.exe + start.cmd → node mcp/index.js) keeps running inside the
 *   Claude Code session, holding read handles on ~/.ownmind/mcp/node_modules/*.js.
 *   git pull / npm install try to overwrite those files → Windows mandatory locking refuses
 *   → EBUSY / EPERM. The user's AI guesses "package.json is in use", but
 *   interactive-upgrade.ps1 does not specifically detect this lock error, and no IR-038
 *   observability record is produced.
 *
 * Fix:
 *   - interactive-upgrade.{sh,ps1}: on failure, scan the log for file-lock signals
 *     (EBUSY / EACCES / "in use" / "another process" / "Permission denied"); if matched:
 *       1. Report-Error -Kind upgrade_file_locked
 *       2. Replace the error code with file_locked (instead of generic git_pull / npm_install).
 *       3. Tell the user explicitly: fully close Claude Code and rerun.
 *   - check-sync.sh: L2 reads the client version via grep text fallback (lock-tolerant).
 */

describe('check-sync.sh — L2 client version reads must be lock-tolerant (v1.17.84)', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'scripts/check-sync.sh'), 'utf8');

  it('L2 section includes grep / sed fallback (not only node -e require)', () => {
    // On failure, fall back to grep on `"version": "X.Y.Z"` text; sturdier against file locks than node require.
    assert.match(content, /grep[^\n]*version|sed[^\n]*version/i,
      'CLIENT_VER read must have a grep/sed text fallback (node require can fail under Windows file lock)');
  });
});

describe('interactive-upgrade.sh — file-lock detection (v1.17.84)', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'scripts/interactive-upgrade.sh'), 'utf8');

  it('detects file-lock patterns (EBUSY / EACCES / "in use", etc.)', () => {
    assert.match(content, /EBUSY|EACCES|in use|another process|Permission denied/i,
      'must detect common file-lock error messages');
  });

  it('reports Report-Error kind=upgrade_file_locked when a lock is detected', () => {
    assert.match(content, /upgrade_file_locked/);
  });

  it('lock message tells the user to close Claude Code', () => {
    assert.match(content, /[Cc]lose.*Claude Code|[Cc]laude Code.*close|restart Claude/i,
      'must tell the user to close Claude Code and rerun (not a generic git pull failed)');
  });
});

describe('interactive-upgrade.ps1 — file-lock detection (v1.17.84)', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'scripts/interactive-upgrade.ps1'), 'utf8');

  it('detects Windows file-lock patterns', () => {
    assert.match(content, /EBUSY|EACCES|in use|another process|Permission denied/i);
  });

  it('reports Report-Error kind=upgrade_file_locked when a lock is detected', () => {
    assert.match(content, /upgrade_file_locked/);
  });

  it('lock message tells the user to close Claude Code', () => {
    assert.match(content, /[Cc]lose.*Claude Code|[Cc]laude Code.*close|restart Claude/i);
  });
});
