import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.80 — install_started beacon spool fallback when upload fails
 * (vin-windows-test, round 4)
 *
 * Root cause (the next layer v1.17.79 missed):
 *   - v1.17.78's Send-InstallBeacon / send_install_beacon was fire-and-forget.
 *   - `try ... catch { }` swallowed upload failures completely, so they never entered retry.
 *   - Real case: vin-windows-test confirmed they were on 1.17.78, but the server saw zero beacons
 *     → Send-InstallBeacon during install.ps1 step 4 (re-run install.ps1) failed silently and the
 *     data was lost. retrySpool could not save it because nothing ever reached the spool.
 *
 * Fix: when a beacon POST fails, append the body to ~/.ownmind/logs/.upload-spool.jsonl.
 * The next self-check runs retrySpool() at the top and re-sends.
 */

describe('install.ps1 Send-InstallBeacon — spool fallback on POST failure (v1.17.80)', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'install.ps1'), 'utf8');

  it('Send-InstallBeacon writes into .upload-spool.jsonl when the beacon fails', () => {
    // Grab the whole Send-InstallBeacon function block and confirm it mentions .upload-spool.jsonl.
    const fnMatch = content.match(/function Send-InstallBeacon[\s\S]+?^\}/m);
    assert.ok(fnMatch, 'Send-InstallBeacon function definition not found');
    assert.match(
      fnMatch[0],
      /\.upload-spool\.jsonl/,
      'Send-InstallBeacon must write to .upload-spool.jsonl on failure (same spool as self-check)'
    );
  });

  it('appends BOM-less UTF-8 (reusing the v1.17.12 pattern)', () => {
    const fnMatch = content.match(/function Send-InstallBeacon[\s\S]+?^\}/m);
    assert.ok(fnMatch);
    // Must use [System.IO.File]::AppendAllText or .NET UTF8Encoding($false)
    // — Add-Content -Encoding UTF8 inserts a BOM on PS 5.1, which breaks downstream Node JSON.parse.
    assert.match(
      fnMatch[0],
      /AppendAllText|UTF8Encoding/,
      'must use the .NET API to append instead of Add-Content (avoid BOM pollution)'
    );
  });
});

describe('install.sh send_install_beacon — spool fallback on POST failure (v1.17.80)', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'install.sh'), 'utf8');

  it('send_install_beacon appends to .upload-spool.jsonl', () => {
    const fnMatch = content.match(/send_install_beacon\(\)\s*\{[\s\S]+?\n\}/m);
    assert.ok(fnMatch, 'send_install_beacon function not found');
    assert.match(
      fnMatch[0],
      /\.upload-spool\.jsonl/,
      'send_install_beacon must append to .upload-spool.jsonl on failure'
    );
  });

  it('returns only when curl succeeds; failures take the spool path', () => {
    const fnMatch = content.match(/send_install_beacon\(\)\s*\{[\s\S]+?\n\}/m);
    assert.ok(fnMatch);
    // Must have an `if curl ... then return` structure.
    assert.match(
      fnMatch[0],
      /if\s+curl[\s\S]*?then[\s\S]*?return/,
      'POST success must return explicitly; only failures fall through to the spool (avoid doing both)'
    );
  });
});
