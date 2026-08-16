import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  startComplianceCheck,
  anySelectorMatches,
} from '../hooks/lib/compliance-step.js';

/**
 * Everything the Stop hook can decide before it costs anybody anything.
 *
 * Tested as a function rather than as pasted-in code, because the first draft of this step
 * referenced a constant the hook does not have (`LINT_DISABLED`; it is `DISABLED`) inside a
 * `catch` that swallowed the ReferenceError. That version would have shipped green and never
 * run once. Nothing here exits a process or writes to a terminal; the caller owns both.
 *
 * v1.30.11 — the judging half of this module is gone. The judge now runs on the user's own
 * Claude Code subscription, which takes 29–54 seconds, so this hook starts one and returns;
 * everything about what the judge FOUND is decided a turn later, in verdict-collect.js, and
 * tested there. What is left here is the part that decides whether to start one at all.
 */

// The banner assertions below are literal-English regexes, and t() resolves locale from this
// real process's env unless pinned.
const ORIGINAL_FORCE = process.env.OWNMIND_LOCALE_FORCE;
beforeEach(() => { process.env.OWNMIND_LOCALE_FORCE = 'en'; });
afterEach(() => {
  if (ORIGINAL_FORCE === undefined) delete process.env.OWNMIND_LOCALE_FORCE;
  else process.env.OWNMIND_LOCALE_FORCE = ORIGINAL_FORCE;
});

const BUNDLE = {
  present: true,
  selectors: [
    { id: 412, type: 'team_standard', tags: [], keywords: ['FAPA'], always_check: false, repo_match: '' },
  ],
  guards: [],
  injectables: [],
};

const BASE = {
  disabled: false,
  mode: 'block',
  apiKey: 'k',
  apiUrl: 'http://server',
  sessionId: 's1',
  assistantText: 'Stage 0 of the FAPA migration: I will add an entry to ci/projects.yml',
  userPrompts: [],
  repoRemote: null,
  trigger: '',
  bundle: BUNDLE,
  startJudgeImpl: () => ({ started: true }),
};

test('a turn a rule bears on starts a judge, and says nothing about it', async () => {
  // Silence is correct here and only here: the judge has been started and its answer arrives
  // next turn. Everything else this function can return is a reason it did NOT.
  let started = null;
  const result = await startComplianceCheck({
    ...BASE,
    startJudgeImpl: (args) => { started = args; return { started: true }; },
  });
  assert.equal(result.action, 'none');
  assert.equal(started.sessionId, 's1');
  assert.match(started.assistantText, /FAPA/);
});

test('nothing in the cached rules bears on this turn, so no judge is started', async () => {
  // Most turns look like this. They must cost no network call, no latency and none of the
  // user's own subscription, or the check becomes a tax on every reply and gets switched off.
  let started = false;
  const result = await startComplianceCheck({
    ...BASE,
    assistantText: 'the tests are green',
    startJudgeImpl: () => { started = true; return { started: true }; },
  });
  assert.equal(started, false);
  assert.equal(result.action, 'none');
});

test('a judge that could not be started is said so, not passed over', async () => {
  // Nothing will write a verdict file, so nothing downstream will ever notice this turn went
  // unchecked. This is the only place it can be said.
  const result = await startComplianceCheck({
    ...BASE,
    startJudgeImpl: () => ({ started: false, reason: 'the job could not be written' }),
  });
  assert.equal(result.action, 'notice');
  assert.equal(result.noticeKey, 'not-checked:judge-not-started');
  assert.match(result.banner, /could not start checking/);
});

test('a disabled session says so rather than passing quietly', async () => {
  const result = await startComplianceCheck({ ...BASE, disabled: true });
  assert.equal(result.action, 'notice');
  assert.match(result.banner, /only warns/);
});

test('warn mode also says so', async () => {
  const result = await startComplianceCheck({ ...BASE, mode: 'warn' });
  assert.equal(result.action, 'notice');
});

test('a machine that never synced says the turn was not checked', async () => {
  // Fresh install, offline, failed sync. Silence here is indistinguishable from "no rule
  // applies", and the difference is whether this machine enforces anything at all.
  const result = await startComplianceCheck({ ...BASE, bundle: { present: false, selectors: [] } });
  assert.equal(result.action, 'notice');
  assert.match(result.banner, /has not downloaded your rules yet/);
  assert.match(result.banner, /did not check the AI's reply/);
});

test('a machine with no credentials says so, never silence', async () => {
  const result = await startComplianceCheck({ ...BASE, apiKey: '', apiUrl: '' });
  assert.equal(result.action, 'notice');
  assert.match(result.banner, /did not check the AI's reply/);
  assert.match(result.banner, /not signed in to OwnMind/);
});

test('every reason not to check has its own notice key', async () => {
  // The throttle announces state CHANGES. Two different reasons sharing a key would read as
  // "same state, stay quiet", and the user would be told to wait out a problem that is not
  // the one they have.
  const keys = new Set();
  for (const ctx of [
    { disabled: true },
    { apiKey: '', apiUrl: '' },
    { bundle: { present: false, selectors: [] } },
    { startJudgeImpl: () => ({ started: false, reason: 'x' }) },
  ]) {
    const r = await startComplianceCheck({ ...BASE, ...ctx });
    keys.add(r.noticeKey);
  }
  assert.equal(keys.size, 4, `two reasons share a notice key: ${[...keys].join(', ')}`);
});

test('the local pre-filter matches the same four ways the server does', () => {
  const ctx = { assistantText: '', userPrompts: [], repoRemote: null, trigger: '' };
  assert.equal(anySelectorMatches([{ always_check: true }], ctx), true);
  assert.equal(anySelectorMatches([{ keywords: ['FAPA'] }], { ...ctx, userPrompts: ['go to fapa'] }), true);
  assert.equal(anySelectorMatches([{ keywords: ['FAPA'] }], { ...ctx, assistantText: 'the FAPA move' }), true);
  assert.equal(anySelectorMatches([{ repo_match: 'mono' }], { ...ctx, repoRemote: 'x/mono.git' }), true);
  assert.equal(anySelectorMatches([{ tags: ['trigger:edit'] }], { ...ctx, trigger: 'edit' }), true);
  assert.equal(anySelectorMatches([{ tags: ['trigger:deploy'] }], { ...ctx, trigger: 'edit' }), false);
  // A reply is several things at once, so the caller passes every label that fits.
  assert.equal(anySelectorMatches([{ tags: ['trigger:report'] }], { ...ctx, trigger: ['respond', 'report'] }), true);
  assert.equal(anySelectorMatches([{ tags: ['trigger:deploy'] }], { ...ctx, trigger: ['respond', 'report'] }), false);
  assert.equal(anySelectorMatches([], ctx), false);
  assert.equal(anySelectorMatches(null, ctx), false);
});
