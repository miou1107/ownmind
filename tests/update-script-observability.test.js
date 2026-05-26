import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.81 — update.ps1 / update.sh observability gap + StackOverflow root-cause fix
 * (vin-windows-test, round 5)
 *
 * Root cause (StackOverflow):
 *   update.ps1 wraps the node JS script in a double-quoted heredoc `@"..."@`, which makes
 *   PowerShell perform variable expansion on the heredoc body. The JS code contains many
 *   `$(...)` and `$variables`, so under Set-StrictMode -Version Latest some paths trigger
 *   recursive PS expansion → StackOverflowException kills the whole process.
 *
 *   Fix: change all four heredocs to single-quoted `@'...'@` form, blocking PS variable
 *   expansion. Every `$`, `$()` in the JS body is preserved verbatim and parsed by node.
 *
 * Observability gap (uncovered by v1.17.79/80):
 *   update.ps1 / update.sh are the "skill / hook sync" light path, parallel to install / upgrade.
 *   v1.17.79 wired the errors/ spool into install + interactive-upgrade but missed update.{ps1,sh}.
 *   That left vin-windows-test round 5 stuck: their AI ran update.ps1 (not bootstrap), it failed,
 *   and the server saw nothing — no beacon, no report-error, no drain spool.
 *
 *   Fix: update.{ps1,sh} adds a beacon (update_started) + try/catch report-error + a drain at the
 *   end, bringing observability to parity with install / upgrade.
 */

describe('update.ps1 — heredoc must be single-quoted to block PS variable expansion (v1.17.81 StackOverflow fix)', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'scripts/update.ps1'), 'utf8');

  it('must not contain @"..."@ double-quoted heredoc (would trigger PS variable expansion on the embedded JS $variables)', () => {
    // Double-quoted heredoc enables variable + subexpression expansion in PS — dangerous around JS code.
    assert.doesNotMatch(
      content,
      /@"\r?\n[\s\S]*?const\s+\w+\s*=/,
      'switch to @\'...\'@ single-quoted heredoc so JS code is preserved verbatim'
    );
  });

  it("preserves at least one @'...'@ single-quoted heredoc (signal that the fix is applied)", () => {
    assert.match(content, /@'\r?\n/, 'must have at least one single-quoted heredoc to count as fixed');
  });
});

describe('update.ps1 — observability channel (v1.17.81 IR-038)', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'scripts/update.ps1'), 'utf8');

  it('sends an update_started beacon at the top (same pattern as install_started)', () => {
    assert.match(content, /update_started/, 'the beacon trigger name should be update_started');
  });

  it('loads the report-error helper (dot-source)', () => {
    assert.match(content, /report-error\.ps1/, 'must source the report-error helper');
  });

  it('header explicitly says "not a full upgrade; use bootstrap for a real upgrade"', () => {
    // Prevents AI assistants from running this as the upgrade path because they see "update".
    assert.match(content, /bootstrap/i, 'header must at least mention bootstrap to guide the right upgrade path');
  });
});

describe('update.sh — observability channel (v1.17.81 IR-038)', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'scripts/update.sh'), 'utf8');

  it('sends an update_started beacon at the top', () => {
    assert.match(content, /update_started/);
  });

  it('sources the report-error helper', () => {
    assert.match(content, /report-error\.sh/);
  });

  it('header explicitly says "not a full upgrade; use bootstrap for a real upgrade"', () => {
    assert.match(content, /bootstrap/i);
  });
});
