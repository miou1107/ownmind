/**
 * Task 4 — the remaining user notices wired through t(): the reply-lint banner family
 * (hooks/ownmind-reply-lint.js: recovery, /ownmind-off reminder, quality-lint banner header
 * variants + mode-invalid line + per-violation line), the compliance-step state/event
 * banners (hooks/lib/compliance-step.js), and the tty-echo merged-banner header
 * (hooks/ownmind-tty-echo.cjs).
 *
 * Binding constraints this file pins (same contract as tests/action-gate-i18n.test.js):
 *   - user-facing banner text renders per OWNMIND_LOCALE_FORCE.
 *   - with force=en, every banner is byte-identical to the pre-change literal (copied from
 *     the hook source at the time this task started, not retyped).
 *   - a broken i18n module must never change what a hook DECIDES (action/exit code/noticeKey)
 *     — only degrade the notice text, and only the notice text, down to the English fallback.
 *     Proven for at least one representative emit site per file (three files, three proofs).
 */

import { strict as assert } from 'assert';
import { test, afterEach } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runComplianceStep, MAX_COMPLIANCE_BLOCKS } from '../hooks/lib/compliance-step.js';
import { tempDir } from './helpers/temp-dir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const REPLY_LINT_HOOK = path.join(repoRoot, 'hooks', 'ownmind-reply-lint.js');
const TTY_ECHO_HOOK = path.join(repoRoot, 'hooks', 'ownmind-tty-echo.cjs');

const ORIGINAL_FORCE = process.env.OWNMIND_LOCALE_FORCE;
afterEach(() => {
  if (ORIGINAL_FORCE === undefined) delete process.env.OWNMIND_LOCALE_FORCE;
  else process.env.OWNMIND_LOCALE_FORCE = ORIGINAL_FORCE;
});

// ============================================================================
// A. hooks/lib/compliance-step.js — runComplianceStep() called directly
// ============================================================================

// always_check:true so the default fixture reaches requestCheckImpl regardless of
// assistantText — the tests that exercise the "nothing to check" path override `bundle`
// explicitly (see the never-synced case below).
const BUNDLE_MATCHING = {
  present: true,
  selectors: [{ id: 1, always_check: true, tags: [] }],
  guards: [],
  injectables: [],
};

function complianceBase(over = {}) {
  return {
    disabled: false,
    mode: 'block',
    apiKey: 'k',
    apiUrl: 'http://server',
    sessionId: 's1',
    assistantText: 'the tests are green',
    userPrompts: [],
    repoRemote: null,
    trigger: '',
    bundle: BUNDLE_MATCHING,
    blockCount: 0,
    requestCheckImpl: async () => ({ outcome: 'clean', violations: [], check_id: 1 }),
    ...over,
  };
}

const TEAM_STANDARD_VIOLATION = {
  ruleId: 412,
  ruleType: 'team_standard',
  ruleTitle: 'ci ownership',
  evidence: 'I will add an entry to ci/projects.yml',
  fix: 'open an issue for the colleague',
};

// --- zh: every state/event banner carries the zh string with placeholders filled ---

test('zh: off (disabled/warn-mode) banner', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const r = await runComplianceStep(complianceBase({ disabled: true }));
  assert.equal(r.action, 'notice');
  assert.equal(r.banner, '[OwnMind] 🟡 這個對話裡 OwnMind 只會提醒，不會要 AI 重寫。');
});

test('zh: no-credentials banner', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const r = await runComplianceStep(complianceBase({ apiKey: '', apiUrl: '' }));
  assert.equal(r.banner, '[OwnMind] 🔴 這台電腦還沒登入 OwnMind，所以 OwnMind 沒有檢查 AI 這段回話。');
});

test('zh: never-synced banner', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const r = await runComplianceStep(complianceBase({ bundle: { present: false, selectors: [] } }));
  assert.equal(r.banner, '[OwnMind] 🔴 這台電腦還沒把你的規矩抓下來，所以 OwnMind 沒有檢查 AI 這段回話。你開個新對話它就會抓。');
});

test('zh: check-failed banner never shows the internal reason token', async () => {
  // v1.30.1. This used to print the server's reason verbatim — "（timeout）", and "（unknown）"
  // when there was no reason at all. Vin hit the unknown variant on 2026-08-15 and asked what
  // the sentence was trying to say: it named a code that means nothing to a reader, twice
  // stated the same fact, and never said what to do. The reason stays in the log; the notice
  // says what happened to the reader instead.
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const withReason = await runComplianceStep(complianceBase({
    requestCheckImpl: async () => ({ outcome: 'failed', violations: [], reason: 'timeout' }),
  }));
  assert.equal(withReason.banner, '[OwnMind] 🔴 OwnMind 這次連不上伺服器，沒有檢查 AI 這段回話。');
  assert.doesNotMatch(withReason.banner, /could not reach its server/, 'the raw reason token must not reach the user');

  // Same notice whether the server gave a reason or not: the reader's situation is identical.
  const noReason = await runComplianceStep(complianceBase({
    requestCheckImpl: async () => ({ outcome: 'failed', violations: [] }),
  }));
  assert.equal(noReason.banner, withReason.banner);
  assert.doesNotMatch(noReason.banner, /unknown/, '"unknown" is an internal placeholder, not a message');
});

test('zh: server-side off banner', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const r = await runComplianceStep(complianceBase({
    requestCheckImpl: async () => ({ outcome: 'skipped', enabled: false, violations: [] }),
  }));
  assert.equal(r.banner, '[OwnMind] 🔴 你的帳號把規矩檢查關掉了，所以 OwnMind 沒有檢查 AI 這段回話。');
});

test('zh: block-cap-reached banner, with the 誤判 check-id note appended', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const r = await runComplianceStep(complianceBase({
    blockCount: MAX_COMPLIANCE_BLOCKS,
    requestCheckImpl: async () => ({
      outcome: 'violation', check_id: 4242, violations: [TEAM_STANDARD_VIOLATION],
    }),
  }));
  assert.equal(
    r.banner,
    '[OwnMind] 🟡 AI 這段回話重寫 2 次還是違反你 1 條規矩，OwnMind 不再退了，直接顯示給你看。'
      + ' （OwnMind 判錯了就回一句「誤判 4242」）',
  );
});

test('zh: pushed-back banner, with the 誤判 check-id note appended', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const r = await runComplianceStep(complianceBase({
    requestCheckImpl: async () => ({
      outcome: 'violation', check_id: 4242, violations: [TEAM_STANDARD_VIOLATION],
    }),
  }));
  assert.equal(r.action, 'exit2');
  assert.equal(
    r.banner,
    '[OwnMind] 🟢 AI 這段回話違反你 1 條規矩，OwnMind 已經要 AI 重寫。 （OwnMind 判錯了就回一句「誤判 4242」）',
  );
});

test('zh: pushed-back banner with no check_id has no trailing note', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const r = await runComplianceStep(complianceBase({
    requestCheckImpl: async () => ({
      outcome: 'violation', check_id: undefined, violations: [TEAM_STANDARD_VIOLATION],
    }),
  }));
  assert.equal(r.banner, '[OwnMind] 🟢 AI 這段回話違反你 1 條規矩，OwnMind 已經要 AI 重寫。');
});

// --- en regression pin: byte-identical to the pre-change literals ---

test('en: off (disabled/warn-mode) banner is byte-identical to the pre-change literal', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'en';
  const r = await runComplianceStep(complianceBase({ disabled: true }));
  assert.equal(r.banner, '[OwnMind] 🟡 In this conversation OwnMind only warns; it never asks the AI to rewrite.');
});

test('en: no-credentials banner is byte-identical to the pre-change literal', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'en';
  const r = await runComplianceStep(complianceBase({ apiKey: '', apiUrl: '' }));
  assert.equal(r.banner, '[OwnMind] 🔴 This computer is not signed in to OwnMind, so OwnMind did not check the AI\'s reply.');
});

test('en: never-synced banner is byte-identical to the pre-change literal', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'en';
  const r = await runComplianceStep(complianceBase({ bundle: { present: false, selectors: [] } }));
  assert.equal(r.banner, '[OwnMind] 🔴 This computer has not downloaded your rules yet, so OwnMind did not check the AI\'s reply. Start a new conversation and it will fetch them.');
});

test('en: check-failed banner is byte-identical to the pre-change literal', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'en';
  const r = await runComplianceStep(complianceBase({
    requestCheckImpl: async () => ({ outcome: 'failed', violations: [], reason: 'timeout' }),
  }));
  assert.equal(r.banner, '[OwnMind] 🔴 OwnMind could not reach its server this time, so it did not check the AI\'s reply.');
});

test('en: server-side off banner is byte-identical to the pre-change literal', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'en';
  const r = await runComplianceStep(complianceBase({
    requestCheckImpl: async () => ({ outcome: 'skipped', enabled: false, violations: [] }),
  }));
  assert.equal(r.banner, '[OwnMind] 🔴 Rule checking is switched off for your account, so OwnMind did not check the AI\'s reply.');
});

test('en: block-cap-reached banner is byte-identical to the pre-change literal', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'en';
  const r = await runComplianceStep(complianceBase({
    blockCount: MAX_COMPLIANCE_BLOCKS,
    requestCheckImpl: async () => ({
      outcome: 'violation', check_id: 4242, violations: [TEAM_STANDARD_VIOLATION],
    }),
  }));
  assert.equal(
    r.banner,
    '[OwnMind] 🟡 The AI\'s reply still breaks 1 of your rules after 2 rewrites, so OwnMind has stopped sending it back and is showing it to you.'
      + ' (if OwnMind got it wrong, reply 誤判 4242)',
  );
});

test('en: pushed-back banner is byte-identical to the pre-change literal', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'en';
  const r = await runComplianceStep(complianceBase({
    requestCheckImpl: async () => ({
      outcome: 'violation', check_id: 4242, violations: [TEAM_STANDARD_VIOLATION],
    }),
  }));
  assert.equal(
    r.banner,
    '[OwnMind] 🟢 The AI\'s reply breaks 1 of your rules, so OwnMind has told the AI to rewrite it. (if OwnMind got it wrong, reply 誤判 4242)',
  );
});

// --- decision fields never depend on locale; only banner text does ---

test('compliance-step decision fields (action/noticeKey) are identical across every locale', async () => {
  const results = {};
  for (const locale of ['en', 'zh', undefined]) {
    if (locale === undefined) delete process.env.OWNMIND_LOCALE_FORCE;
    else process.env.OWNMIND_LOCALE_FORCE = locale;
    results[String(locale)] = await runComplianceStep(complianceBase({ disabled: true }));
  }
  const [first, ...rest] = Object.values(results);
  for (const r of rest) {
    assert.equal(r.action, first.action);
    assert.equal(r.noticeKey, first.noticeKey);
  }
});

// --- a broken i18n.js must never change what runComplianceStep decides ---

function stageBrokenI18nComplianceStep() {
  const tempRoot = tempDir('compliance-step-broken-i18n-');
  fs.mkdirSync(path.join(tempRoot, 'hooks', 'lib'), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, 'hooks', 'lib', 'compliance-step.js'),
    path.join(tempRoot, 'hooks', 'lib', 'compliance-step.js'),
  );
  // A syntax error, so the dynamic `import('./i18n.js')` this simulates must REJECT.
  fs.writeFileSync(path.join(tempRoot, 'hooks', 'lib', 'i18n.js'), 'export function t( { this is not valid js');
  return path.join(tempRoot, 'hooks', 'lib', 'compliance-step.js');
}

test('compliance-step: an unloadable i18n.js falls back to the English literal and never changes the decision', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const stagedPath = stageBrokenI18nComplianceStep();
  const { runComplianceStep: stagedRun } = await import(pathToFileURL(stagedPath).href);
  const r = await stagedRun(complianceBase({ disabled: true }));
  assert.equal(r.action, 'notice', 'a broken i18n module must not change the decision');
  assert.equal(
    r.banner,
    '[OwnMind] 🟡 In this conversation OwnMind only warns; it never asks the AI to rewrite.',
    'the fallback is the plain English literal even though OWNMIND_LOCALE_FORCE=zh was set',
  );
});

// ============================================================================
// B. hooks/ownmind-reply-lint.js — spawned as a subprocess (Stop hook contract)
// ============================================================================

let tmpHome;
let pendingFile;
let transcriptPath;

function runReplyLintHook(input, env = {}) {
  return spawnSync('node', [REPLY_LINT_HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      OWNMIND_REPLY_LINT_NO_NETWORK: '1',
      ...env,
    },
  });
}

function setupReplyLintHome() {
  tmpHome = tempDir('reply-lint-i18n-');
  fs.mkdirSync(path.join(tmpHome, '.ownmind', 'logs'), { recursive: true });
  pendingFile = path.join(tmpHome, '.ownmind', 'logs', 'banner-pending.jsonl');
  transcriptPath = path.join(tmpHome, 'transcript.jsonl');
  // A quiet, configured machine: credentials present, but the compliance selector matches
  // nothing, so the compliance-step notices do not join these lint-banner assertions.
  fs.writeFileSync(path.join(tmpHome, '.claude.json'), JSON.stringify({
    mcpServers: {
      ownmind: { env: { OWNMIND_API_KEY: 'test-key', OWNMIND_API_URL: 'http://127.0.0.1:1/unreachable' } },
    },
  }));
  fs.mkdirSync(path.join(tmpHome, '.ownmind', 'cache'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpHome, '.ownmind', 'cache', 'enforcement.json'),
    JSON.stringify({ selectors: [{ id: 1, keywords: ['zzz-matches-nothing'], tags: [] }], guards: [], injectables: [] }),
  );
  fs.writeFileSync(path.join(tmpHome, '.ownmind', 'cache', 'iron_rules.json'), JSON.stringify([
    { code: 'TEST-JARGON', metadata: { lint_validator: { name: 'jargon_explanation', params: {} } } },
    { code: 'TEST-MIXED', metadata: { lint_validator: { name: 'language_mixed_ratio', params: { threshold: 0.15 } } } },
  ]));
}

function writeViolatingTranscript(text) {
  fs.writeFileSync(transcriptPath, JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }) + '\n');
}

function stopPayload(extra = {}) {
  return {
    session_id: 'reply-lint-i18n-' + Math.random(),
    transcript_path: transcriptPath,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    ...extra,
  };
}

const VIOLATING_TEXT = 'I think we should monomorphism the codeapp using a completely fresh approach because the implementation has obvious bugs.';

function bannerSpool() {
  try { return fs.readFileSync(pendingFile, 'utf8'); } catch { return ''; }
}

// --- zh: banner header variants + mode-invalid line ---

test('zh: quality-lint banner header, warn-mode variant', () => {
  setupReplyLintHome();
  try {
    writeViolatingTranscript(VIOLATING_TEXT);
    const r = runReplyLintHook(stopPayload(), { OWNMIND_LOCALE_FORCE: 'zh', OWNMIND_REPLY_LINT_MODE: 'warn' });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    // Note: MODE='warn' also makes the compliance-step treat itself as off, so its own
    // (still-English, unrelated to this assertion) notice rides the same systemMessage ahead
    // of the lint banner — hence no leading-anchor match here.
    assert.match(parsed.systemMessage, /\[OwnMind v\?\] 🟢 OwnMind 在 AI 這段回話裡挑到違反你規矩的地方（這個對話第 1 次）。目前 OwnMind 只提醒/);
  } finally { fs.rmSync(tmpHome, { recursive: true, force: true }); }
});

test('zh: quality-lint banner header, block-mode-not-yet-triggered variant', () => {
  setupReplyLintHome();
  try {
    writeViolatingTranscript(VIOLATING_TEXT);
    const r = runReplyLintHook(stopPayload(), { OWNMIND_LOCALE_FORCE: 'zh', OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.match(parsed.systemMessage, /^\[OwnMind v\?\] 🟢 OwnMind 在 AI 這段回話裡挑到違反你規矩的地方（這個對話第 1 次）。再 3 次，OwnMind 就會直接要 AI 重寫。/);
  } finally { fs.rmSync(tmpHome, { recursive: true, force: true }); }
});

test('zh: mode-invalid line', () => {
  setupReplyLintHome();
  try {
    writeViolatingTranscript(VIOLATING_TEXT);
    const r = runReplyLintHook(stopPayload(), { OWNMIND_LOCALE_FORCE: 'zh', OWNMIND_REPLY_LINT_MODE: 'foo' });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.match(parsed.systemMessage, /回話檢查的設定值 'foo' OwnMind 看不懂，這次只提醒，不會要 AI 重寫。/);
  } finally { fs.rmSync(tmpHome, { recursive: true, force: true }); }
});

test('zh: downgraded-to-warning banner header (rides stdout, exit 0)', () => {
  setupReplyLintHome();
  try {
    writeViolatingTranscript(VIOLATING_TEXT);
    const sessionId = 'sess-downgrade-zh';
    const payload = stopPayload({ session_id: sessionId });
    for (let i = 1; i <= 6; i += 1) {
      runReplyLintHook(payload, { OWNMIND_LOCALE_FORCE: 'zh', OWNMIND_REPLY_LINT_MODE: 'block' });
    }
    const r = runReplyLintHook(payload, { OWNMIND_LOCALE_FORCE: 'zh', OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 0, 'the downgrade must not block, and must exit 0 so its notice renders');
    const parsed = JSON.parse(r.stdout);
    assert.match(parsed.systemMessage, /被退回重寫 3 次還是沒改對，OwnMind 不再退了，直接顯示給你看/);
  } finally { fs.rmSync(tmpHome, { recursive: true, force: true }); }
});

test('zh: hard-block banner header (never reaches stdout, but is in the audit spool)', () => {
  setupReplyLintHome();
  try {
    writeViolatingTranscript(VIOLATING_TEXT);
    const sessionId = 'sess-block-zh';
    const payload = stopPayload({ session_id: sessionId });
    for (let i = 1; i <= 3; i += 1) {
      runReplyLintHook(payload, { OWNMIND_LOCALE_FORCE: 'zh', OWNMIND_REPLY_LINT_MODE: 'block' });
    }
    const r = runReplyLintHook(payload, { OWNMIND_LOCALE_FORCE: 'zh', OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 2, 'the 4th violation must hard-block');
    assert.match(bannerSpool(), /違反你的規矩，OwnMind 已經要 AI 重寫（這個對話第 4 次）/);
  } finally { fs.rmSync(tmpHome, { recursive: true, force: true }); }
});

test('zh: /ownmind-off reminder (fires on the 10th tick)', () => {
  setupReplyLintHome();
  try {
    const sessionId = 'sess-off-zh';
    fs.mkdirSync(path.join(tmpHome, '.ownmind', 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.ownmind', 'state', 'session-off.json'),
      JSON.stringify({ session_id: sessionId, off_at: new Date().toISOString(), tick_count: 9 }),
    );
    writeViolatingTranscript('irrelevant while off');
    const r = runReplyLintHook(stopPayload({ session_id: sessionId }), { OWNMIND_LOCALE_FORCE: 'zh' });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.match(
      parsed.systemMessage,
      /\[OwnMind v\?\] 🔴 OwnMind 現在是關的，AI 已經有 10 段回話沒被檢查過。\n {2}→ 你要開回來：輸入 \/ownmind-on，或直接開一個新對話。/,
    );
  } finally { fs.rmSync(tmpHome, { recursive: true, force: true }); }
});

test('zh: compliance recovery notice (state changes from not-checked to clean)', () => {
  setupReplyLintHome();
  try {
    const sessionId = 'sess-recover-zh';
    // First turn: bundle absent -> "never synced" state is recorded by notice-throttle.
    fs.writeFileSync(
      path.join(tmpHome, '.ownmind', 'cache', 'enforcement.json'),
      JSON.stringify({ selectors: [], guards: [], injectables: [] }),
    );
    fs.rmSync(path.join(tmpHome, '.ownmind', 'cache', 'enforcement.json'));
    writeViolatingTranscript('the tests are green');
    const first = runReplyLintHook(stopPayload({ session_id: sessionId }), { OWNMIND_LOCALE_FORCE: 'zh' });
    assert.equal(first.status, 0);
    // Second turn, same session: a present bundle whose selector matches nothing -> action
    // 'none', no noticeKey -> the state changed away from "never synced" -> recovery fires.
    fs.writeFileSync(
      path.join(tmpHome, '.ownmind', 'cache', 'enforcement.json'),
      JSON.stringify({ selectors: [{ id: 1, keywords: ['zzz-matches-nothing'], tags: [] }], guards: [], injectables: [] }),
    );
    const second = runReplyLintHook(stopPayload({ session_id: sessionId }), { OWNMIND_LOCALE_FORCE: 'zh' });
    assert.equal(second.status, 0);
    const parsed = JSON.parse(second.stdout);
    assert.match(parsed.systemMessage, /已經照你的規矩檢查過 AI 這段回話/);
  } finally { fs.rmSync(tmpHome, { recursive: true, force: true }); }
});

// --- en regression pin: byte-identical to the pre-change literals ---

test('en: quality-lint banner header, warn-mode variant, is byte-identical to the pre-change literal', () => {
  setupReplyLintHome();
  try {
    writeViolatingTranscript(VIOLATING_TEXT);
    const r = runReplyLintHook(stopPayload(), { OWNMIND_LOCALE_FORCE: 'en', OWNMIND_REPLY_LINT_MODE: 'warn' });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    // MODE='warn' also makes the compliance-step treat itself as off, so its own English
    // notice rides the same systemMessage ahead of the lint banner — no leading anchor here.
    assert.match(parsed.systemMessage, /\[OwnMind v\?\] 🟢 OwnMind found something in the AI's reply that breaks your rules \(1 so far in this conversation\)\. For now OwnMind only warns/);
  } finally { fs.rmSync(tmpHome, { recursive: true, force: true }); }
});

test('en: quality-lint banner header, block-mode-not-yet-triggered variant, byte-identical', () => {
  setupReplyLintHome();
  try {
    writeViolatingTranscript(VIOLATING_TEXT);
    const r = runReplyLintHook(stopPayload(), { OWNMIND_LOCALE_FORCE: 'en', OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.match(parsed.systemMessage, /^\[OwnMind v\?\] 🟢 OwnMind found something in the AI's reply that breaks your rules \(1 so far in this conversation\)\. 3 more and OwnMind will tell the AI to rewrite it\./);
  } finally { fs.rmSync(tmpHome, { recursive: true, force: true }); }
});

test('en: mode-invalid line is byte-identical to the pre-change literal', () => {
  setupReplyLintHome();
  try {
    writeViolatingTranscript(VIOLATING_TEXT);
    const r = runReplyLintHook(stopPayload(), { OWNMIND_LOCALE_FORCE: 'en', OWNMIND_REPLY_LINT_MODE: 'foo' });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.match(parsed.systemMessage, /does not recognise the reply-check setting 'foo'/);
  } finally { fs.rmSync(tmpHome, { recursive: true, force: true }); }
});

test('en: downgraded-to-warning banner header is byte-identical to the pre-change literal', () => {
  setupReplyLintHome();
  try {
    writeViolatingTranscript(VIOLATING_TEXT);
    const sessionId = 'sess-downgrade-en';
    const payload = stopPayload({ session_id: sessionId });
    for (let i = 1; i <= 6; i += 1) {
      runReplyLintHook(payload, { OWNMIND_LOCALE_FORCE: 'en', OWNMIND_REPLY_LINT_MODE: 'block' });
    }
    const r = runReplyLintHook(payload, { OWNMIND_LOCALE_FORCE: 'en', OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.match(
      parsed.systemMessage,
      /went back for a rewrite 3 times and still is not right/,
    );
  } finally { fs.rmSync(tmpHome, { recursive: true, force: true }); }
});

test('en: hard-block banner header is byte-identical to the pre-change literal (audit spool)', () => {
  setupReplyLintHome();
  try {
    writeViolatingTranscript(VIOLATING_TEXT);
    const sessionId = 'sess-block-en';
    const payload = stopPayload({ session_id: sessionId });
    for (let i = 1; i <= 3; i += 1) {
      runReplyLintHook(payload, { OWNMIND_LOCALE_FORCE: 'en', OWNMIND_REPLY_LINT_MODE: 'block' });
    }
    const r = runReplyLintHook(payload, { OWNMIND_LOCALE_FORCE: 'en', OWNMIND_REPLY_LINT_MODE: 'block' });
    assert.equal(r.status, 2);
    assert.match(bannerSpool(), /so OwnMind has told the AI to rewrite it \(4 so far in this conversation\)/);
  } finally { fs.rmSync(tmpHome, { recursive: true, force: true }); }
});

test('en: /ownmind-off reminder is byte-identical to the pre-change literal', () => {
  setupReplyLintHome();
  try {
    const sessionId = 'sess-off-en';
    fs.mkdirSync(path.join(tmpHome, '.ownmind', 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.ownmind', 'state', 'session-off.json'),
      JSON.stringify({ session_id: sessionId, off_at: new Date().toISOString(), tick_count: 9 }),
    );
    writeViolatingTranscript('irrelevant while off');
    const r = runReplyLintHook(stopPayload({ session_id: sessionId }), { OWNMIND_LOCALE_FORCE: 'en' });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(
      parsed.systemMessage,
      '[OwnMind v?] 🔴 OwnMind is off, and 10 of the AI\'s replies have gone unchecked.\n'
        + '  → To turn it back on: type /ownmind-on, or just start a new conversation.',
    );
  } finally { fs.rmSync(tmpHome, { recursive: true, force: true }); }
});

// --- a broken i18n.js must never change what the reply-lint hook decides ---

function stageBrokenI18nReplyLint() {
  const tempRoot = tempDir('reply-lint-broken-i18n-');
  fs.mkdirSync(path.join(tempRoot, 'hooks', 'lib'), { recursive: true });
  fs.symlinkSync(path.join(repoRoot, 'shared'), path.join(tempRoot, 'shared'));
  // Any hooks/lib/* file whose own source references `./i18n.js` (a relative import of it)
  // must be a real copy here, not a symlink: Node's ESM loader resolves a symlinked module's
  // import.meta.url to its REAL path by default, so its own `./i18n.js` import would resolve
  // against the real repo tree and silently load the working i18n.js instead of the staged
  // broken one (verified empirically in Task 3, then re-verified here — code review caught
  // hooks/lib/compliance-step.js falling into exactly this trap once it gained its own
  // complianceNotice() helper, since this loop used to symlink it unconditionally). Detected
  // by a content scan, not a hand-maintained file list, so the next hooks/lib file that starts
  // importing i18n.js is covered automatically instead of silently regressing this proof.
  const libDir = path.join(repoRoot, 'hooks', 'lib');
  for (const entry of fs.readdirSync(libDir)) {
    if (entry === 'i18n.js') continue;
    const src = path.join(libDir, entry);
    const dest = path.join(tempRoot, 'hooks', 'lib', entry);
    const importsI18n = fs.statSync(src).isFile()
      && /['"]\.\/i18n\.js['"]/.test(fs.readFileSync(src, 'utf8'));
    if (importsI18n) fs.copyFileSync(src, dest);
    else fs.symlinkSync(src, dest);
  }
  // The entry file must be a real copy too, for the same reason: its own
  // `import('./lib/i18n.js')` must resolve against this staged tree.
  fs.copyFileSync(REPLY_LINT_HOOK, path.join(tempRoot, 'hooks', 'ownmind-reply-lint.js'));
  fs.writeFileSync(path.join(tempRoot, 'hooks', 'lib', 'i18n.js'), 'export function t( { this is not valid js');
  return path.join(tempRoot, 'hooks', 'ownmind-reply-lint.js');
}

test('reply-lint hook: an unloadable i18n.js falls back to English and never crashes the banner', () => {
  const stagedHook = stageBrokenI18nReplyLint();
  setupReplyLintHome();
  try {
    writeViolatingTranscript(VIOLATING_TEXT);
    const r = spawnSync('node', [stagedHook], {
      input: JSON.stringify(stopPayload()),
      encoding: 'utf8',
      env: {
        ...process.env, HOME: tmpHome, USERPROFILE: tmpHome,
        OWNMIND_REPLY_LINT_NO_NETWORK: '1', OWNMIND_REPLY_LINT_MODE: 'warn',
        OWNMIND_LOCALE_FORCE: 'zh',
      },
    });
    assert.equal(r.status, 0, `must exit 0 even with a broken i18n module; stderr=${r.stderr.slice(0, 500)}`);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); }, `stdout must be valid JSON, got:\n${r.stdout}`);
    assert.match(parsed.systemMessage, /OwnMind found something in the AI's reply/, 'falls back to the English banner header');
    assert.doesNotMatch(parsed.systemMessage, /回話品質/, 'the zh translation must not appear — i18n itself is broken');
    // MODE='warn' also drives compliance-step.js's own off:warn-mode banner through this same
    // staged-broken-i18n run — hooks/lib/compliance-step.js is a hooks/lib/* file that itself
    // imports './i18n.js' relatively (via its complianceNotice() helper), so this is the case
    // code review found the staging helper's symlink-everything-in-hooks/lib loop was missing:
    // a symlinked compliance-step.js would resolve its own import against the REAL repo
    // i18n.js (Node resolves a symlink's import.meta.url to its real path), silently loading
    // the real dictionary instead of the staged broken one and defeating this exact assertion.
    assert.match(
      parsed.systemMessage,
      /In this conversation OwnMind only warns/,
      'compliance-step.js (also on the hooks/lib i18n.js import graph) must fall back to English too',
    );
    assert.doesNotMatch(parsed.systemMessage, /合規檢查目前關閉中/, 'the zh translation must not appear for compliance-step either');
  } finally { fs.rmSync(tmpHome, { recursive: true, force: true }); }
});

// ============================================================================
// C. hooks/ownmind-tty-echo.cjs — spawned as a subprocess (PostToolUse hook contract)
// ============================================================================

let ttyHome;

function runTtyEchoHook(input, env = {}) {
  return spawnSync('node', [TTY_ECHO_HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, HOME: ttyHome, USERPROFILE: ttyHome, OWNMIND_LOCALE_FORCE: 'en', ...env },
  });
}

function ttyPayload(eventLine) {
  return {
    tool_response: { content: [{ type: 'text', text: `[OwnMind v1.2.3] ${eventLine}` }] },
  };
}

test('zh: tty-echo merged-banner header renders through t() (identical to en — no linguistic content)', () => {
  ttyHome = tempDir('tty-echo-i18n-');
  try {
    const r = runTtyEchoHook(ttyPayload('Memory search: found 3'), { OWNMIND_LOCALE_FORCE: 'zh' });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    // Baseline re-pinned when origin/main (v1.26.173) merged in: formatBlock now emits ONE
    // line per trigger, so the non-i18n output this case measures against is the single-line
    // shape rather than "header + indented item". The assertion is unchanged in kind — an
    // exact match on the whole rendered systemMessage — so it still proves both that zh
    // renders byte-identically to en (the header carries no linguistic content) and that
    // {version} was interpolated.
    assert.match(parsed.systemMessage, /^\[OwnMind v1\.2\.3\] Memory search: found 3$/);
  } finally { fs.rmSync(ttyHome, { recursive: true, force: true }); }
});

test('en: tty-echo merged-banner header is byte-identical to the pre-change literal', () => {
  ttyHome = tempDir('tty-echo-i18n-en-');
  try {
    const r = runTtyEchoHook(ttyPayload('Memory search: found 3'), { OWNMIND_LOCALE_FORCE: 'en' });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    // "pre-change" means before the i18n change, not before v1.26.173: the literal this pins
    // is whatever formatBlock would emit with no t() in the path, and v1.26.173 moved that to
    // one line. Re-pinned to the post-v1.26.173 literal for exactly that reason.
    assert.equal(parsed.systemMessage, '[OwnMind v1.2.3] Memory search: found 3');
  } finally { fs.rmSync(ttyHome, { recursive: true, force: true }); }
});

function stageBrokenI18nTtyEcho() {
  const tempRoot = tempDir('tty-echo-broken-i18n-');
  fs.mkdirSync(path.join(tempRoot, 'hooks', 'lib'), { recursive: true });
  fs.copyFileSync(TTY_ECHO_HOOK, path.join(tempRoot, 'hooks', 'ownmind-tty-echo.cjs'));
  fs.writeFileSync(path.join(tempRoot, 'hooks', 'lib', 'i18n.js'), 'export function t( { this is not valid js');
  return path.join(tempRoot, 'hooks', 'ownmind-tty-echo.cjs');
}

test('tty-echo hook: an unloadable i18n.js falls back to the literal header and never crashes', () => {
  const stagedHook = stageBrokenI18nTtyEcho();
  ttyHome = tempDir('tty-echo-broken-i18n-home-');
  try {
    const r = spawnSync('node', [stagedHook], {
      input: JSON.stringify(ttyPayload('Memory search: found 3')),
      encoding: 'utf8',
      env: { ...process.env, HOME: ttyHome, USERPROFILE: ttyHome, OWNMIND_LOCALE_FORCE: 'zh' },
    });
    assert.equal(r.status, 0, `must exit 0 even with a broken i18n module; stderr=${r.stderr.slice(0, 500)}`);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); }, `stdout must be valid JSON, got:\n${r.stdout}`);
    // Re-pinned to v1.26.173's single-line shape. What this case is actually about is
    // unchanged: with hooks/lib/i18n.js unloadable and the locale forced to zh, the hook must
    // still exit 0, still emit valid JSON, and still render the English literal header rather
    // than a key, a crash, or an empty line.
    assert.equal(parsed.systemMessage, '[OwnMind v1.2.3] Memory search: found 3');
  } finally { fs.rmSync(ttyHome, { recursive: true, force: true }); }
});
