import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';
import { buildInjection, PRECEDENCE_SENTENCE } from '../hooks/ownmind-prompt-inject.js';

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
  const precedenceAt = text.indexOf(PRECEDENCE_SENTENCE);
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
  assert.match(out, /never synced|has not synced/i);
});
