import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';
import { buildInjection, precedenceFor, PRECEDENCE_BY_TYPE } from '../hooks/ownmind-prompt-inject.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(repoRoot, 'hooks', 'ownmind-prompt-inject.js');

/**
 * Putting the standard in front of the assistant before it starts.
 *
 * The 2026-08-13 incident was not a delivery failure - the text was in context and the
 * assistant broke the rule anyway, because a permissions list inside the repository looked
 * more authoritative than the standard. Delivering the same words earlier does not fix that
 * by itself, which is why every injection leads with the precedence sentence and with the
 * forbidden paths, and only then carries the body.
 *
 * These fixtures are the flat `injectables` shape the enforcement bundle ships. Anything
 * written against the database's nested `metadata.enforcement` would match nothing on a real
 * machine and everything in a test built from a hand-written row.
 */

const CI_STANDARD = {
  id: 412,
  type: 'team_standard',
  title: 'ci ownership belongs to the colleague',
  content: 'The /ci directory is maintained by the colleague. No other engineer may modify it.',
  keywords: ['FAPA', 'onboarding'],
  always_check: false,
  repo_match: 'guarded-monorepo',
  paths: ['ci/**', '.gitlab-ci.yml'],
  owner: 'Colleague',
};

const ALWAYS_RULE = {
  id: 125,
  type: 'iron_rule',
  title: 'conclusion first',
  content: 'Lead with the conclusion.',
  keywords: [],
  always_check: true,
  repo_match: '',
  paths: [],
  owner: '',
};

test('a keyword in the prompt injects the standard', () => {
  const { text, injectedIds } = buildInjection([CI_STANDARD], 'ownmind 專案要遷移到 FAPA', null, []);
  assert.deepEqual(injectedIds, [412]);
  assert.match(text, /No other engineer may modify it/);
});

test('the precedence sentence comes before the body, not after it', () => {
  // The body alone is what the assistant already had when it broke the rule. What was
  // missing is the sentence saying the standard outranks the repository, so that sentence
  // cannot be buried underneath 3500 characters of standard.
  const { text } = buildInjection([CI_STANDARD], 'FAPA', null, []);
  const precedenceAt = text.indexOf(precedenceFor('team_standard'));
  const bodyAt = text.indexOf('The /ci directory is maintained');
  assert.ok(precedenceAt >= 0, 'the precedence sentence is missing entirely');
  assert.ok(precedenceAt < bodyAt, 'the precedence sentence must precede the body');
});

test('the forbidden paths and the owner are stated up front', () => {
  const { text } = buildInjection([CI_STANDARD], 'FAPA', null, []);
  const head = text.slice(0, text.indexOf('The /ci directory is maintained'));
  assert.match(head, /ci\/\*\*/);
  assert.match(head, /Colleague/);
});

test('matching is case-insensitive', () => {
  const { injectedIds } = buildInjection([CI_STANDARD], 'planning the fapa migration', null, []);
  assert.deepEqual(injectedIds, [412]);
});

test('an always_check rule is injected whatever the prompt says', () => {
  const { injectedIds } = buildInjection([ALWAYS_RULE], 'what is the weather', null, []);
  assert.deepEqual(injectedIds, [125]);
});

test('being inside the guarded repo injects the standard without any keyword', () => {
  const { injectedIds } = buildInjection(
    [CI_STANDARD], 'tidy up the readme', 'https://example.com/guarded-monorepo.git', [],
  );
  assert.deepEqual(injectedIds, [412]);
});

test('an unrelated prompt in an unrelated repo injects nothing', () => {
  const { text, injectedIds } = buildInjection(
    [CI_STANDARD], 'what is the weather', 'https://example.com/something-else.git', [],
  );
  assert.equal(text, '');
  assert.deepEqual(injectedIds, []);
});

test('a standard already injected this session is not injected again', () => {
  // Otherwise the same 3500 characters are prepended to every matching prompt for the whole
  // session, which is both expensive and the fastest way to teach someone to ignore it.
  const { text, injectedIds } = buildInjection([CI_STANDARD], 'FAPA', null, [412]);
  assert.equal(text, '');
  assert.deepEqual(injectedIds, []);
});

test('a standard with no body still carries its prohibition header', () => {
  const bodyless = { ...CI_STANDARD, content: '' };
  const { text, injectedIds } = buildInjection([bodyless], 'FAPA', null, []);
  assert.deepEqual(injectedIds, [412]);
  assert.match(text, /ci\/\*\*/);
  assert.match(text, /Colleague/);
});

test('no injectables means no output and no crash', () => {
  assert.deepEqual(buildInjection([], 'FAPA', null, []), { text: '', injectedIds: [] });
  assert.deepEqual(buildInjection(null, 'FAPA', null, []), { text: '', injectedIds: [] });
});

test('the hook run as a program emits the injection and remembers it', () => {
  const home = tempDir('om-inject-home-');
  fs.mkdirSync(path.join(home, '.ownmind', 'cache'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.ownmind', 'cache', 'enforcement.json'),
    JSON.stringify({ selectors: [], guards: [], injectables: [CI_STANDARD] }),
  );

  const run = () => execFileSync('node', [HOOK], {
    input: JSON.stringify({ session_id: 's-inject', prompt: 'migrate ownmind to FAPA' }),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
    timeout: 30_000,
  });

  const first = JSON.parse(run());
  assert.equal(first.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(first.hookSpecificOutput.additionalContext, /No other engineer may modify it/);

  // Second prompt, same session: the dedup has to survive the process ending, which means it
  // has to be on disk. Held in memory it would reset on every prompt and never dedup at all.
  const second = run();
  assert.equal(second.trim(), '', 'the standard was injected twice in one session');
});

test('a prompt with nothing to inject produces no output at all', () => {
  const home = tempDir('om-inject-home-');
  fs.mkdirSync(path.join(home, '.ownmind', 'cache'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.ownmind', 'cache', 'enforcement.json'),
    JSON.stringify({ selectors: [], guards: [], injectables: [CI_STANDARD] }),
  );
  const out = execFileSync('node', [HOOK], {
    input: JSON.stringify({ session_id: 's-quiet', prompt: 'what is the weather' }),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
    timeout: 30_000,
  });
  assert.equal(out.trim(), '');
});

test('a machine that never synced says so instead of staying silent', () => {
  // Fresh install, offline, failed sync - the cache is absent and nothing can be injected.
  // Silence there is indistinguishable from "no standard applies", and the difference is
  // whether this machine is enforcing anything at all.
  const home = tempDir('om-inject-home-');
  const out = execFileSync('node', [HOOK], {
    input: JSON.stringify({ session_id: 's-nosync', prompt: 'migrate to FAPA' }),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
    timeout: 30_000,
  });
  assert.match(out, /No rules cache on this machine/i);
});

test('a team standard says it belongs to the team and cannot simply be waived', () => {
  // The decision behind this wording: most of what a team standard protects is somebody
  // else's, so "Vin said it was fine" is not enough on its own.
  const { text } = buildInjection([CI_STANDARD], 'FAPA', null, []);
  assert.match(text, /TEAM standard/);
  assert.match(text, /outranks their personal iron rules/);
  assert.match(text, /確認/, 'a team standard override needs an explicit confirmation');
});

test('an iron rule says the user may set it aside, because it is theirs', () => {
  const { text } = buildInjection([ALWAYS_RULE], 'anything', null, []);
  assert.match(text, /own iron rule/);
  assert.match(text, /the team standard governs/);
  assert.match(text, /may set this aside/);
  assert.doesNotMatch(text, /確認/, 'the user does not have to confirm to waive their own rule');
});

test('a principle and a preference say plainly that they yield', () => {
  const principle = { ...ALWAYS_RULE, id: 900, type: 'principle', content: 'p' };
  const preference = { ...ALWAYS_RULE, id: 901, type: 'profile', content: 'q' };
  assert.match(buildInjection([principle], 'x', null, []).text, /unless an iron rule or a team/);
  const prefText = buildInjection([preference], 'x', null, []).text;
  assert.match(prefText, /not a rule/);
  assert.match(prefText, /when nothing above it decides/);
});

test('every shipped type has its own sentence, and an unknown type still gets one', () => {
  // A type with no sentence must not fall through to silence: an injected rule with no
  // precedence line is the exact state the 2026-08-13 incident happened in.
  for (const type of ['team_standard', 'iron_rule', 'coding_standard', 'principle', 'profile']) {
    assert.ok(PRECEDENCE_BY_TYPE[type], `no precedence sentence for ${type}`);
  }
  assert.ok(precedenceFor('something_new_next_year').length > 0);
});

test('the header names the kind of rule, not always "standard"', () => {
  assert.match(buildInjection([CI_STANDARD], 'FAPA', null, []).text, /\[OwnMind team_standard 412\]/);
  assert.match(buildInjection([ALWAYS_RULE], 'x', null, []).text, /\[OwnMind iron_rule 125\]/);
});

// ============================================================
// bug-report id=27 — the same "never synced" paragraph on every single turn
//
// Two things went wrong at once, and only together do they explain why the warning stopped
// being read. It repeated verbatim on every prompt of a long session, dozens of times,
// including turns with nothing to do with standards. And there was no way to check it: the
// reporter ran `ownmind_search` (which reads the server and worked) and `check-sync.sh`
// (which reported in_sync on all three layers) and concluded the hook was stale. Neither tool
// looks at the file this notice is about, and the notice never said which file that was.
//
// A warning nobody can verify, arriving sixty times, teaches people to scroll past it — which
// costs more than the silence it was written to prevent. The user-facing signal is not lost:
// reply-lint's own not-checked banner speaks on every change of state and every tenth turn
// while the state holds.
// ============================================================

function runHook(home, sessionId, prompt = 'migrate to FAPA') {
  return execFileSync('node', [HOOK], {
    input: JSON.stringify({ session_id: sessionId, prompt }),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
    timeout: 30_000,
  });
}

test('the never-synced notice arrives once in a session, not on every prompt', () => {
  const home = tempDir('om-inject-nosync-once-');

  const first = runHook(home, 's-repeat', 'migrate to FAPA');
  const second = runHook(home, 's-repeat', 'what is the weather');
  const third = runHook(home, 's-repeat', 'now deploy it');

  assert.match(first, /enforcement\.json/, `the first turn must say it; got ${first}`);
  assert.doesNotMatch(second, /enforcement\.json/, `turn 2 repeated it; got ${second}`);
  assert.doesNotMatch(third, /enforcement\.json/, `turn 3 repeated it; got ${third}`);
});

test('a different session hears it too — the count is per session, not per machine', () => {
  const home = tempDir('om-inject-nosync-persession-');
  runHook(home, 's-one');

  const other = runHook(home, 's-two');

  assert.match(other, /enforcement\.json/, `a new session was left in the dark; got ${other}`);
});

test('with no session id it is said every time rather than once for ever', () => {
  // Every session without an id shares one state file, so a flag written there would silence
  // the machine permanently instead of for one session. Repeating is the lesser fault.
  const home = tempDir('om-inject-nosync-nosession-');

  const first = runHook(home, '');
  const second = runHook(home, '');

  assert.match(first, /enforcement\.json/);
  assert.match(second, /enforcement\.json/, `a machine with no session id went permanently quiet; got ${second}`);
});

test('the notice names the file that is missing, so the claim can be checked', () => {
  const home = tempDir('om-inject-nosync-named-');

  const out = runHook(home, 's-named');

  assert.match(out, /enforcement\.json/, 'the reader has to be able to look');
  assert.match(out, /ownmind_search|check-sync/,
    'and has to be told why the two obvious checks disagree');
});

test('once the cache is there the notice stops, in the same session', () => {
  const home = tempDir('om-inject-nosync-recovers-');
  runHook(home, 's-recovers');

  fs.mkdirSync(path.join(home, '.ownmind', 'cache'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.ownmind', 'cache', 'enforcement.json'),
    JSON.stringify({ selectors: [], guards: [], injectables: [CI_STANDARD] }),
  );
  const out = runHook(home, 's-recovers', 'FAPA');

  assert.doesNotMatch(out, /enforcement\.json is missing|has not synced|never synced/i);
  assert.match(out, /TEAM standard/, 'and the standards themselves come through');
});
