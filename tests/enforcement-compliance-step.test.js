import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.js';
import {
  runComplianceStep,
  anySelectorMatches,
  formatViolationFeedback,
  MAX_COMPLIANCE_BLOCKS,
} from '../hooks/lib/compliance-step.js';
import { _logPathForTests } from '../hooks/lib/check-failure-log.js';

// Task 4 (hook message i18n) wired runComplianceStep()'s banners through t(), which resolves
// locale from this real process's env/home unless pinned. This suite's banner assertions
// (e.g. /only warns/, /has not downloaded your rules yet/) are literal-English regexes, so the locale is
// pinned to 'en' for the whole file — same pattern as tests/action-gate.test.js (Task 3).
const ORIGINAL_FORCE = process.env.OWNMIND_LOCALE_FORCE;

// v1.30.2: a failed check now writes a diagnosis line, so the whole file is pointed at a
// throwaway path — otherwise running the suite appends to the developer's own machine log.
const LOG_FILE = path.join(tempDir('om-step-failures-'), 'check-failures.jsonl');
const readLoggedFailures = () => {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

beforeEach(() => {
  process.env.OWNMIND_LOCALE_FORCE = 'en';
  _logPathForTests(LOG_FILE);
});
afterEach(() => {
  if (ORIGINAL_FORCE === undefined) delete process.env.OWNMIND_LOCALE_FORCE;
  else process.env.OWNMIND_LOCALE_FORCE = ORIGINAL_FORCE;
  _logPathForTests(null);
});

/**
 * The decision the stop hook carries out.
 *
 * Tested as a function rather than as pasted-in code, because the first draft of this step
 * referenced a constant the hook does not have (`LINT_DISABLED`; it is `DISABLED`) inside a
 * `catch` that swallowed the ReferenceError. That version would have shipped green and never
 * run once. Nothing here exits a process or writes to a terminal; the caller owns both.
 */

const TEAM_STANDARD_VIOLATION = {
  ruleId: 412,
  ruleType: 'team_standard',
  ruleTitle: 'ci ownership',
  evidence: 'I will add an entry to ci/projects.yml',
  fix: 'open an issue for the colleague',
};

const OWN_RULE_VIOLATION = {
  ruleId: 125,
  ruleType: 'iron_rule',
  ruleCode: 'IR-125',
  ruleTitle: 'conclusion first',
  evidence: 'First let me walk you through what I searched',
  fix: 'lead with the conclusion',
};

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
  blockCount: 0,
  requestCheckImpl: async () => ({ outcome: 'clean', violations: [], check_id: 1 }),
};

test('a violation asks the caller to exit 2 and hands it the text for the AI', async () => {
  const result = await runComplianceStep({
    ...BASE,
    requestCheckImpl: async () => ({
      outcome: 'violation', check_id: 7, violations: [TEAM_STANDARD_VIOLATION],
    }),
  });
  assert.equal(result.action, 'exit2');
  assert.match(result.stderr, /412/);
  assert.match(result.stderr, /open an issue/);
  assert.match(result.stderr, /I will add an entry to ci\/projects\.yml/);
});

test('nothing in the cached rules bears on this turn, so no request is made', async () => {
  // Most turns look like this. They must cost no network call and no latency, or the check
  // becomes a tax on every reply and gets switched off.
  let called = false;
  const result = await runComplianceStep({
    ...BASE,
    assistantText: 'the tests are green',
    requestCheckImpl: async () => { called = true; return { outcome: 'clean', violations: [] }; },
  });
  assert.equal(called, false);
  assert.equal(result.action, 'none');
});

test('a disabled session says so rather than passing quietly', async () => {
  const result = await runComplianceStep({ ...BASE, disabled: true });
  assert.equal(result.action, 'notice');
  assert.match(result.banner, /only warns/);
});

test('warn mode also says so', async () => {
  const result = await runComplianceStep({ ...BASE, mode: 'warn' });
  assert.equal(result.action, 'notice');
});

test('a machine that never synced says the turn was not checked', async () => {
  // Fresh install, offline, failed sync. Silence here is indistinguishable from "no rule
  // applies", and the difference is whether this machine enforces anything at all.
  const result = await runComplianceStep({ ...BASE, bundle: { present: false, selectors: [] } });
  assert.equal(result.action, 'notice');
  assert.match(result.banner, /has not downloaded your rules yet/);
  assert.match(result.banner, /did not check the AI's reply/);
});

test('a failed check produces a visible notice, never silence', async () => {
  const result = await runComplianceStep({
    ...BASE,
    requestCheckImpl: async () => ({
      outcome: 'failed', violations: [], failure: 'timeout', reason: 'timeout',
    }),
  });
  assert.equal(result.action, 'notice');
  assert.match(result.banner, /could not reach its server/);
  assert.match(result.banner, /did not check the AI's reply/);
});

/**
 * v1.30.2 — a key the server no longer accepts is not an outage.
 *
 * It never heals, so the outage sentence is both wrong and unactionable: it invites the user
 * to wait for something that will still be broken next week. The two states also have to be
 * distinct notice keys, or the throttle treats the transition as "same state, stay quiet".
 */
test('a rejected key tells the user to sign in again, not that the server is down', async () => {
  const result = await runComplianceStep({
    ...BASE,
    requestCheckImpl: async () => ({
      outcome: 'failed', violations: [], failure: 'unauthorized', reason: 'http 401',
    }),
  });
  assert.equal(result.action, 'notice');
  assert.equal(result.noticeKey, 'not-checked:signed-out');
  assert.match(result.banner, /does not recognise this computer/);
  assert.match(result.banner, /sign in again/);
  assert.ok(!/could not reach its server/.test(result.banner), result.banner);
});

test('an outage keeps its own notice key, so the change between the two is announced', async () => {
  const result = await runComplianceStep({
    ...BASE,
    requestCheckImpl: async () => ({
      outcome: 'failed', violations: [], failure: 'network', reason: 'ECONNREFUSED',
    }),
  });
  assert.equal(result.noticeKey, 'not-checked:check-failed');
});

test('a server that answered but could not finish is not called unreachable', async () => {
  // This is the likeliest failure in production — the rule fetch or the judge failing behind an
  // HTTP 200 — and "could not reach its server" is simply false about it, on top of pointing
  // the reader at their own network. It asks nothing of them: there is nothing here to fix.
  const result = await runComplianceStep({
    ...BASE,
    requestCheckImpl: async () => ({
      outcome: 'failed', violations: [], failure: 'server-declined', reason: 'server answered failed',
    }),
  });
  assert.equal(result.noticeKey, 'not-checked:server-declined');
  assert.ok(!/could not reach/.test(result.banner), result.banner);
  assert.match(result.banner, /nothing for you to do/i);
});

test('why the check did not run is written down, since the notice cannot say it', async () => {
  // The notice carries no error text on purpose — "http 401" is the internal vocabulary the
  // message rules ban. That left the reason with no sink at all: this is the sink.
  const before = readLoggedFailures().length;
  await runComplianceStep({
    ...BASE,
    sessionId: 'sess-42',
    requestCheckImpl: async () => ({
      outcome: 'failed', violations: [], failure: 'unauthorized', reason: 'http 401',
    }),
  });
  const written = readLoggedFailures().slice(before);
  assert.equal(written.length, 1);
  assert.equal(written[0].session_id, 'sess-42');
  assert.equal(written[0].failure, 'unauthorized');
  assert.equal(written[0].reason, 'http 401');
});

test('when the server recorded the failure itself, the local line can be joined to its row', async () => {
  // The server answers 200 with outcome:'failed' for its own four failures, three of which
  // carry a check_id. Dropping it leaves a local line that says a check did not run and no way
  // to reach the row that says why.
  const before = readLoggedFailures().length;
  await runComplianceStep({
    ...BASE,
    requestCheckImpl: async () => ({
      outcome: 'failed', violations: [], failure: 'server-declined',
      reason: 'server answered failed', check_id: 77,
    }),
  });
  const written = readLoggedFailures().slice(before);
  assert.equal(written.length, 1);
  assert.equal(written[0].check_id, 77);
  assert.equal(written[0].failure, 'server-declined');
});

test('a check that ran writes nothing to the failure log', async () => {
  const before = readLoggedFailures().length;
  await runComplianceStep(BASE);
  assert.equal(readLoggedFailures().length, before);
});

test('a clean verdict is silent', async () => {
  const result = await runComplianceStep(BASE);
  assert.equal(result.action, 'none');
});

// v1.26.171 — every way of being OFF must be loud. The audit found two silent ones: the
// server saying "enforcement is switched off for this account" was treated exactly like a
// clean verdict, and a machine with no credentials returned nothing at all. Both read as
// "checked and passed", which is the one impersonation the product forbids.
test('a server-side skip says enforcement is off, never silence', async () => {
  const result = await runComplianceStep({
    ...BASE,
    requestCheckImpl: async () => ({ outcome: 'skipped', enabled: false, violations: [] }),
  });
  assert.equal(result.action, 'notice');
  assert.match(result.banner, /did not check the AI's reply/);
  assert.match(result.banner, /switched off/);
});

test('a machine with no credentials says so, never silence', async () => {
  const result = await runComplianceStep({ ...BASE, apiKey: '', apiUrl: '' });
  assert.equal(result.action, 'notice');
  assert.match(result.banner, /did not check the AI's reply/);
  assert.match(result.banner, /not signed in to OwnMind/);
});

test('the blocking stderr carries the check id for 誤判 reporting', async () => {
  // Until now the id lived only in banners, and banners never rendered — so the
  // false-positive feedback loop had no possible client. The stderr path is the one the
  // user provably sees (it renders as the block reason).
  const text = formatViolationFeedback([OWN_RULE_VIOLATION], { checkId: 4242 });
  assert.match(text, /4242/);
  assert.match(text, /誤判/);
});

test('the pushback stops after the cap, rather than trading turns for ever', async () => {
  const result = await runComplianceStep({
    ...BASE,
    blockCount: MAX_COMPLIANCE_BLOCKS,
    requestCheckImpl: async () => ({
      outcome: 'violation', check_id: 9, violations: [TEAM_STANDARD_VIOLATION],
    }),
  });
  assert.equal(result.action, 'notice');
  assert.match(result.banner, /still breaks/);
});

test('the banner carries the check id and how to report a false alarm', async () => {
  // The false-positive rate is what decides whether this widens beyond one account, and it
  // cannot be computed from findings nobody could flag.
  const result = await runComplianceStep({
    ...BASE,
    requestCheckImpl: async () => ({
      outcome: 'violation', check_id: 4242, violations: [TEAM_STANDARD_VIOLATION],
    }),
  });
  assert.match(result.banner, /4242/);
  assert.match(result.banner, /誤判/);
});

test('a team standard violation tells the AI the user cannot simply waive it', async () => {
  const text = formatViolationFeedback([TEAM_STANDARD_VIOLATION]);
  assert.match(text, /Team standard/);
  assert.match(text, /確認/);
});

test('the user\'s own rule does not demand a confirmation', async () => {
  const text = formatViolationFeedback([OWN_RULE_VIOLATION]);
  assert.match(text, /IR-125/);
  assert.ok(!text.includes('確認'), 'the user does not confirm to waive their own rule');
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
