/**
 * P3: update_ok event-semantics tests
 *
 * Background (Bob case, 2026-04-26): Bob's client was 1.17.10; the dashboard showed
 * `update_check + update_ok` events for him on 4/26, yet the client was actually still 1.17.10.
 *
 * Root cause: mcp/index.js's background-update exec callback wrote `update_ok` whenever
 * the shell exited 0, but the shell exits 0 in all of these cases:
 *   - UPDATES="" no new commits to pull (no entry into the if, but the marker echo still exits 0)
 *   - git pull failed but was swallowed by `2>/dev/null` + `||` fallback
 *   - npm install / update.sh silent fail
 *
 * Net result: `update_ok` (the literal meaning is "upgrade succeeded") ≠ the actual semantics ("shell did not blow up").
 *
 * Fix:
 *   - Split `update_ok` into `update_applied` (a new commit was actually pulled) and
 *     `update_clean` (no new version available).
 *   - Each key step in the shell (git pull / npm install / update.sh) explicitly traps the exit code.
 *   - Dashboard label mapping updated to match.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mcpSource = readFileSync(join(__dirname, '..', 'mcp', 'index.js'), 'utf8');
const hookSource = readFileSync(join(__dirname, '..', 'hooks', 'ownmind-session-start.sh'), 'utf8');
const dashboardHtml = readFileSync(join(__dirname, '..', 'legacy', 'admin-v1.26', 'index.html'), 'utf8');

test('P3: mcp/index.js no longer hardcodes update_ok (must split into update_applied / update_clean)', () => {
  // Before: ` logEvent('update_ok', { source: 'mcp' });` appeared in the callback else branch.
  // After: the string should be gone entirely.
  assert.equal(
    mcpSource.includes("logEvent('update_ok'"),
    false,
    'update_ok must be retired in favor of update_applied (new commit pulled) and update_clean (no new version)'
  );
});

test('P3: mcp/index.js must write update_applied for the "new commit pulled" case', () => {
  assert.match(
    mcpSource,
    /logEvent\(['"]update_applied['"]/,
    'mcp/index.js must include logEvent("update_applied", ...) corresponding to the dashboard "updated" label'
  );
});

test('P3: mcp/index.js must write update_clean for the "no new version" case', () => {
  assert.match(
    mcpSource,
    /logEvent\(['"]update_clean['"]/,
    'mcp/index.js must include logEvent("update_clean", ...) corresponding to the dashboard "no new version" label'
  );
});

test('P3: mcp/index.js must branch update_applied / update_clean explicitly (no longer relying on shell markers)', () => {
  // After v1.17.22 we use Node-native execFile and no longer __OM_APPLIED__ / __OM_CLEAN__ shell markers.
  // But the update_applied vs update_clean semantic split is still the P3 core:
  //   - new commit pulled + all steps succeeded → update_applied
  //   - no new commits (git log HEAD..origin/main empty) → update_clean
  assert.match(
    mcpSource,
    /logEvent\(['"]update_applied['"]/,
    'mcp/index.js must write update_applied after pulling a new commit and all steps succeeding'
  );
  assert.match(
    mcpSource,
    /logEvent\(['"]update_clean['"]/,
    'mcp/index.js must write update_clean when no new version is available; never silently complete'
  );
});

test('P3: mcp/index.js must explicitly write update_failed when any key step fails (no silent swallow)', () => {
  // v1.17.22 refactored to Node-native after the Alice/Bob Windows silent-skip incident.
  // Any step failure (fetch / log / pull / npm / update_sh) flows through fail() helper,
  // which writes update_failed with the step name.
  assert.match(
    mcpSource,
    /logEvent\(['"]update_failed['"][^)]*step/,
    'update_failed event must carry a step field to identify which stage failed'
  );
  // Must cover every key step.
  for (const step of ['fetch', 'pull', 'npm', 'update_sh']) {
    assert.ok(
      mcpSource.includes(`'${step}'`) || mcpSource.includes(`"${step}"`),
      `step="${step}" must appear in the update_failed path`
    );
  }
});

test('P3: dashboard label must include update_clean (previously only update_check + update_applied)', () => {
  // index.html already has 'update_check: 檢查更新' and 'update_applied: 已更新'.
  // It must also add 'update_clean: 無新版'; otherwise the new event renders as the raw English key.
  assert.match(
    dashboardHtml,
    /update_clean\s*:\s*['"][^'"]+['"]/,
    'legacy/admin-v1.26/index.html ZH label map must include the Chinese label for update_clean'
  );
});

test('P3: dashboard label must include update_failed (previously absent entirely)', () => {
  assert.match(
    dashboardHtml,
    /update_failed\s*:\s*['"][^'"]+['"]/,
    'legacy/admin-v1.26/index.html ZH label map must include update_failed; otherwise users see the raw key'
  );
});

// ────────────────────────────────────────────────────────────
// hooks/ownmind-session-start.sh receives the same fix (the dual bug surfaced in review).
// Before, the hook shared the same silent-fail pattern as mcp/index.js, but the hook fires far more
// often (every SessionStart) than the MCP startup, so the false-positive update_applied impact is bigger.
// The fix must align; otherwise P3 is only half solved.
// ────────────────────────────────────────────────────────────

test('P3: hook must not unconditionally write update_applied after git pull (must inspect each step\'s exit code)', () => {
  // Pre-fix pattern:
  //   git pull -q --rebase 2>/dev/null || git pull -q 2>/dev/null
  //   cd "$OWNMIND_DIR/mcp" && npm install -q 2>/dev/null
  //   bash ... update.sh >/dev/null 2>&1
  //   log_event "update_applied"   ← unconditional
  // After the fix: each step is wrapped in `if !; then log_event "update_failed"; exit; fi`.
  // Regression guard: the hook must not include the "git pull ... || git pull ..." pattern immediately
  // followed by log_event "update_applied" (no exit-code check in between). Use the count of `if ! ` instead.
  const ifNotCount = (hookSource.match(/if ! /g) || []).length;
  assert.ok(
    ifNotCount >= 4,
    `hook must explicitly check exit codes (if ! ...) for fetch/pull/npm/update.sh; currently only ${ifNotCount} occurrences of "if !"`
  );
});

test('P3: hook must be able to write update_clean (no-new-version scenario)', () => {
  assert.match(
    hookSource,
    /log_event\s+["']update_clean["']/,
    'hook must log update_clean when UPDATES is empty; never silently complete'
  );
});

test('P3: hook must be able to write update_failed (any step error)', () => {
  assert.match(
    hookSource,
    /log_event\s+["']update_failed["']/,
    'hook must log update_failed when any of fetch/pull/npm/update.sh fails; no silent swallow'
  );
});

// ────────────────────────────────────────────────────────────
// v1.17.19 follow-up fix (project_281 backlog item C):
// LOCK_FILE touch failure (disk full / readonly FS) was not previously detected;
// the rest would continue without the lock → race-condition risk.
// Aligned with the P3 "each step explicitly trapped" principle, lock failure is also a marker.
// ────────────────────────────────────────────────────────────

test('P3-lock: mcp/index.js LOCK_FILE acquire failure must write update_failed step=lock (v1.17.23 atomic openSync wx)', () => {
  // v1.17.19: shell `touch "${LOCK_FILE}" || echo __OM_LOCK_FAIL__`
  // v1.17.22: fs.writeFileSync wrapped in try/catch (but with a TOCTOU race)
  // v1.17.23: fs.openSync(LOCK_FILE, 'wx') atomic create; EEXIST → lock_held; other errors → update_failed step=lock
  assert.match(
    mcpSource,
    /fs\.openSync\(LOCK_FILE,\s*['"]wx['"]\)[\s\S]{0,400}step:\s*['"]lock['"]/,
    'mcp/index.js must atomically acquire with openSync wx and write update_failed step=lock on non-EEXIST failures'
  );
});

test('P3-lock: hooks/ownmind-session-start.sh must log update_failed step=lock when touch LOCK_FILE fails', () => {
  // Pre-fix: `touch "$LOCK_FILE"` without || ...
  // After: `touch "$LOCK_FILE" || { log_event "update_failed" "step" "lock"; exit 0; }`
  assert.match(
    hookSource,
    /touch\s+"\$LOCK_FILE"\s*\|\|\s*\{[^}]*log_event[^}]*update_failed[^}]*lock/,
    'hook must log update_failed step=lock when touch LOCK_FILE fails; never silently proceed'
  );
});
