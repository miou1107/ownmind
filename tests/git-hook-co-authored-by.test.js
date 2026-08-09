import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dirname, '..', 'hooks', 'ownmind-git-commit-msg');

// v1.26.104: $HOME points at an empty sandbox, not the developer's real home. The wrapper
// now runs the user's own cached rules, so with a real $HOME these cases would start
// depending on whatever that person happens to have written down — a
// `commit_message_contains` rule of their own would turn "accepts plain commit message"
// red for reasons unrelated to this code. What is under test here is the trailer guard.
function runHook(message) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-hook-test-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'om-hook-home-'));
  const msgFile = path.join(tmpDir, 'COMMIT_EDITMSG');
  fs.writeFileSync(msgFile, message);
  try {
    execFileSync(HOOK, [msgFile], {
      stdio: 'pipe',
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
    });
    return { code: 0, stderr: '' };
  } catch (e) {
    return { code: e.status ?? -1, stderr: e.stderr?.toString() ?? '' };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

test('rejects Co-Authored-By trailer (standard case)', () => {
  const r = runHook('feat: x\n\nCo-Authored-By: Claude <a@b>\n');
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /Co-Authored-By/);
});

test('rejects Co-authored-by trailer (git standard lowercase)', () => {
  const r = runHook('feat: x\n\nCo-authored-by: Claude <a@b>\n');
  assert.strictEqual(r.code, 1);
});

test('rejects co-authored-by (full lowercase)', () => {
  const r = runHook('feat: x\n\nco-authored-by: Claude <a@b>\n');
  assert.strictEqual(r.code, 1);
});

test('rejects indented Co-Authored-By trailer', () => {
  const r = runHook('feat: x\n\n  Co-Authored-By: Claude <a@b>\n');
  assert.strictEqual(r.code, 1);
});

test('accepts plain commit message', () => {
  const r = runHook('feat: add new feature\n');
  assert.strictEqual(r.code, 0);
});

test('accepts other trailers (Reviewed-by)', () => {
  const r = runHook('feat: x\n\nReviewed-by: Vin\n');
  assert.strictEqual(r.code, 0);
});

test('accepts prose mentioning co-authored without trailer format', () => {
  const r = runHook('docs: explain co-authored convention in body text\n');
  assert.strictEqual(r.code, 0);
});
