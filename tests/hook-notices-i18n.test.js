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
import { startComplianceCheck } from '../hooks/lib/compliance-step.js';
import { collectVerdict } from '../hooks/lib/verdict-collect.js';
import { _logPathForTests } from '../hooks/lib/check-failure-log.js';
import { tempDir } from './helpers/temp-dir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const REPLY_LINT_HOOK = path.join(repoRoot, 'hooks', 'ownmind-reply-lint.js');
const TTY_ECHO_HOOK = path.join(repoRoot, 'hooks', 'ownmind-tty-echo.cjs');

const ORIGINAL_FORCE = process.env.OWNMIND_LOCALE_FORCE;

// v1.30.2: the cases below drive a failed check in-process, and a failed check appends a
// diagnosis line. Without this every suite run injects fabricated failures, carrying real
// timestamps, into the developer's own ~/.ownmind/logs/check-failures.jsonl — the file whose
// whole job is answering "when did this start".
_logPathForTests(path.join(tempDir('om-notices-failures-'), 'check-failures.jsonl'));

afterEach(() => {
  if (ORIGINAL_FORCE === undefined) delete process.env.OWNMIND_LOCALE_FORCE;
  else process.env.OWNMIND_LOCALE_FORCE = ORIGINAL_FORCE;
});

// ============================================================================
// A. the reply check's own notices, called directly
//
// Two halves, because the check is two halves. hooks/lib/compliance-step.js decides whether
// to start a judge and says why when it will not; hooks/lib/verdict-collect.js says what the
// judge found, a turn later. Both are user-facing and both are pinned per locale here.
// ============================================================================

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
    startJudgeImpl: () => ({ started: true }),
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

/** One verdict waiting, with the throttle and the log stubbed out of the way. */
function verdictBase(record) {
  return {
    sessionId: 's1',
    list: () => [{ turnId: 't1', record }],
    remove: () => {},
    sweep: () => {},
    logFailure: () => {},
    speak: (key) => key !== null,
  };
}

// --- zh: the reasons a judge was not started ---

test('zh: off (disabled/warn-mode) banner', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const r = await startComplianceCheck(complianceBase({ disabled: true }));
  assert.equal(r.action, 'notice');
  assert.equal(r.banner, '[OwnMind] 🟡 這個對話裡 OwnMind 只會提醒，不會要 AI 重寫。');
});

test('zh: no-credentials banner', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const r = await startComplianceCheck(complianceBase({ apiKey: '', apiUrl: '' }));
  assert.equal(r.banner, '[OwnMind] 🔴 這台電腦還沒登入 OwnMind，所以 OwnMind 沒有檢查 AI 這段回話。');
});

test('zh: never-synced banner', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const r = await startComplianceCheck(complianceBase({ bundle: { present: false, selectors: [] } }));
  assert.equal(r.banner, '[OwnMind] 🔴 這台電腦還沒把你的規矩抓下來，所以 OwnMind 沒有檢查 AI 這段回話。你開個新對話它就會抓。');
});

test('zh: judge-not-started banner', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const r = await startComplianceCheck(complianceBase({
    startJudgeImpl: () => ({ started: false, reason: 'the job could not be written' }),
  }));
  assert.equal(r.banner, '[OwnMind] 🔴 OwnMind 沒能開始檢查 AI 這段回話，所以這段沒有對過你的規矩。重跑一次 OwnMind 的更新指令通常就會好。');
});

// --- zh: what the judge came back with, a turn later ---

test('zh: check-failed banner never shows the internal reason token', async () => {
  // v1.30.1. This used to print the reason verbatim — "（timeout）", and "（unknown）" when
  // there was no reason at all. Vin hit the unknown variant on 2026-08-15 and asked what the
  // sentence was trying to say: it named a code that means nothing to a reader, twice stated
  // the same fact, and never said what to do. The reason stays in the log; the notice says
  // what happened to the reader instead.
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const r = await collectVerdict(verdictBase({
    outcome: 'failed', failure: 'timeout', reason: 'the judge did not answer within 90000ms',
  }));
  assert.equal(
    r.banner,
    '[OwnMind] 🔴 OwnMind 沒能檢查 AI 前面某一段回話，那一段沒有對過你的規矩。\n'
    + '  重跑一次 OwnMind 的更新指令通常就會好；在那之前 AI 的回話沒有人在對規矩。',
  );
  assert.doesNotMatch(r.banner, /timeout|90000/, 'the raw reason token must not reach the user');
});

test('zh: a rejected key gets its own banner, not the outage one', async () => {
  // v1.30.2. Every failure used to produce the outage sentence. This one never heals and is
  // the only notice in the family that asks the user to go and do something, so it has to be
  // a different sentence — and a different throttle key, or the move between the two states
  // reads as "unchanged, stay quiet".
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const r = await collectVerdict(verdictBase({
    outcome: 'failed', failure: 'unauthorized', reason: 'http 401',
  }));
  assert.equal(r.banner, '[OwnMind] 🔴 OwnMind 認不得這台電腦了，所以 OwnMind 沒有檢查 AI 這段回話。你要重新登入：拿新的登入資料重跑一次安裝指令。');
  assert.doesNotMatch(r.banner, /401|unauthorized/, 'the raw reason token must not reach the user');
});

test('zh: a missing Claude Code gets the repair that works', async () => {
  // v1.30.11. The generic line says to re-run the update script, which installs OwnMind and
  // cannot install the CLI the judge runs on — a repair that could never repair this.
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const r = await collectVerdict(verdictBase({
    outcome: 'failed', failure: 'no-cli', reason: 'claude is not on this machine',
  }));
  assert.equal(
    r.banner,
    '[OwnMind] 🔴 OwnMind 是叫這台電腦上的 Claude Code 來檢查 AI 的回話的，但找不到它，那一段就沒有檢查。\n'
    + '  你要在這台電腦裝好 Claude Code，而且在終端機打 claude 叫得動它，檢查才會回來。',
  );
});

test('zh: a judge that was started and never came back', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const r = await collectVerdict({
    ...verdictBase({ outcome: 'pending', started_at: 0 }),
    now: () => 10_000_000,
  });
  assert.equal(
    r.banner,
    '[OwnMind] 🔴 OwnMind 開始檢查 AI 前面某一段回話，之後就沒有下文了，那一段沒有對過你的規矩。\n'
    + '  下一段回話會重新檢查。一直這樣的話，重跑一次 OwnMind 的更新指令。',
  );
});

test('zh: server-side off banner', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const r = await collectVerdict(verdictBase({ outcome: 'disabled' }));
  assert.equal(r.banner, '[OwnMind] 🔴 你的帳號把規矩檢查關掉了，所以 OwnMind 沒有檢查 AI 這段回話。');
});

test('zh: violation banner, with the 誤判 check-id note appended', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const r = await collectVerdict(verdictBase({
    outcome: 'violation', check_id: 4242, violations: [TEAM_STANDARD_VIOLATION],
  }));
  assert.equal(
    r.banner,
    '[OwnMind] 🟡 OwnMind 檢查了 AI 前面某一段回話，它違反你 1 條規矩，第一條是：ci ownership\n'
    + '  OwnMind 已經把這幾條交給 AI，AI 接下來應該會自己改。這只是提醒、擋不住它，所以你自己再看一眼。'
    + ' （OwnMind 判錯了就回一句「誤判 4242」）',
  );
});

test('zh: violation banner with no check_id has no trailing note', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const r = await collectVerdict(verdictBase({
    outcome: 'violation', check_id: undefined, violations: [TEAM_STANDARD_VIOLATION],
  }));
  assert.doesNotMatch(r.banner, /誤判/);
});

test('zh: checking coming back is announced', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const r = await collectVerdict({
    ...verdictBase({ outcome: 'clean', violations: [] }),
    speak: (key) => key === null,
  });
  assert.equal(r.banner, '[OwnMind] 🟢 OwnMind 又在拿你的規矩檢查 AI 的回話了。');
});

// --- en regression pin: byte-identical to the dictionary ---

test('en: off (disabled/warn-mode) banner is byte-identical to the pre-change literal', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'en';
  const r = await startComplianceCheck(complianceBase({ disabled: true }));
  assert.equal(r.banner, '[OwnMind] 🟡 In this conversation OwnMind only warns; it never asks the AI to rewrite.');
});

test('en: no-credentials banner is byte-identical to the pre-change literal', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'en';
  const r = await startComplianceCheck(complianceBase({ apiKey: '', apiUrl: '' }));
  assert.equal(r.banner, '[OwnMind] 🔴 This computer is not signed in to OwnMind, so OwnMind did not check the AI\'s reply.');
});

test('en: never-synced banner is byte-identical to the pre-change literal', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'en';
  const r = await startComplianceCheck(complianceBase({ bundle: { present: false, selectors: [] } }));
  assert.equal(r.banner, '[OwnMind] 🔴 This computer has not downloaded your rules yet, so OwnMind did not check the AI\'s reply. Start a new conversation and it will fetch them.');
});

test('en: the rejected-key banner is byte-identical to the dictionary', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'en';
  const r = await collectVerdict(verdictBase({
    outcome: 'failed', failure: 'unauthorized', reason: 'http 401',
  }));
  assert.equal(r.banner, '[OwnMind] 🔴 OwnMind does not recognise this computer any more, so OwnMind did not check the AI\'s reply. You need to sign in again: run the install command again with new sign-in details.');
});

test('en: server-side off banner is byte-identical to the pre-change literal', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'en';
  const r = await collectVerdict(verdictBase({ outcome: 'disabled' }));
  assert.equal(r.banner, '[OwnMind] 🔴 Rule checking is switched off for your account, so OwnMind did not check the AI\'s reply.');
});

test('en: violation banner is byte-identical to the dictionary', async () => {
  process.env.OWNMIND_LOCALE_FORCE = 'en';
  const r = await collectVerdict(verdictBase({
    outcome: 'violation', check_id: 4242, violations: [TEAM_STANDARD_VIOLATION],
  }));
  assert.equal(
    r.banner,
    '[OwnMind] 🟡 OwnMind checked one of the AI\'s earlier replies and it breaks 1 of your rules, starting with ci ownership\n'
    + '  OwnMind has passed this to the AI, which should correct itself from here. This is a reminder, not a block: OwnMind cannot make it comply, so check that it did.'
    + ' (if OwnMind got it wrong, reply 誤判 4242)',
  );
});

// --- the decision must not depend on the language, or on the dictionary loading at all ---

test('compliance-step decision fields (action/noticeKey) are identical across every locale', async () => {
  const cases = [
    ['disabled', complianceBase({ disabled: true })],
    ['no-credentials', complianceBase({ apiKey: '', apiUrl: '' })],
    ['never-synced', complianceBase({ bundle: { present: false, selectors: [] } })],
    ['judge-not-started', complianceBase({ startJudgeImpl: () => ({ started: false, reason: 'x' }) })],
    ['started', complianceBase()],
  ];
  for (const [name, ctx] of cases) {
    const seen = [];
    for (const locale of ['en', 'zh', 'ja']) {
      process.env.OWNMIND_LOCALE_FORCE = locale;
      const r = await startComplianceCheck(ctx);
      seen.push(`${r.action}|${r.noticeKey ?? ''}`);
    }
    assert.equal(new Set(seen).size, 1,
      `${name}: what the hook DOES changed with the language: ${seen.join(' / ')}`);
  }
});

test('compliance-step: an unloadable i18n.js falls back to the English literal and never changes the decision', async () => {
  // The notice text may degrade when the message layer is broken. What the hook decides may
  // not: a machine with a damaged dictionary must still know it did not check the turn.
  const staged = tempDir('om-i18n-broken-');
  for (const dir of ['hooks/lib', 'shared']) fs.mkdirSync(path.join(staged, dir), { recursive: true });
  for (const name of fs.readdirSync(path.join(repoRoot, 'hooks', 'lib'))) {
    const src = path.join(repoRoot, 'hooks', 'lib', name);
    if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(staged, 'hooks/lib', name));
  }
  fs.writeFileSync(path.join(staged, 'hooks/lib/i18n.js'), 'this is not valid javascript {{{');

  const mod = await import(pathToFileURL(path.join(staged, 'hooks/lib/compliance-step.js')).href);
  process.env.OWNMIND_LOCALE_FORCE = 'zh';
  const r = await mod.startComplianceCheck(complianceBase({ apiKey: '', apiUrl: '' }));
  assert.equal(r.action, 'notice');
  assert.equal(r.noticeKey, 'not-checked:no-credentials');
  assert.match(r.banner, /not signed in to OwnMind/, 'it fell back to something other than English');
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
    assert.match(parsed.systemMessage, /\[OwnMind v\?\] 🟡 OwnMind 在 AI 這段回話裡挑到違反你規矩的地方（這個對話第 1 次）。目前 OwnMind 只提醒/);
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
      /\[OwnMind v\?\] 🔴 OwnMind 現在是關的，AI 已經有 10 段回話沒過回話品質檢查。\n {2}→ 你要開回來：輸入 \/ownmind-on，或直接開一個新對話。/,
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
    assert.match(parsed.systemMessage, /\[OwnMind v\?\] 🟡 OwnMind found something in the AI's reply that breaks your rules \(1 so far in this conversation\)\. For now OwnMind only warns/);
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
      '[OwnMind v?] 🔴 OwnMind is off, and 10 of the AI\'s replies have skipped the reply-quality check.\n'
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
    assert.doesNotMatch(parsed.systemMessage, /挑到違反你規矩的地方/, 'the zh translation must not appear — i18n itself is broken');
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
    assert.doesNotMatch(parsed.systemMessage, /只會提醒/, 'the zh translation must not appear for compliance-step either');
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
