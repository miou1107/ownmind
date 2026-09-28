import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { anySelectorMatches } from '../hooks/lib/compliance-step.js';
import { selectRules } from '../src/lib/enforcement/select-rules.js';
import {
  TRIGGER_TAG_ALIASES,
  KNOWN_TRIGGER_WORDS,
  unknownTriggerTags,
} from '../shared/helpers.js';

/**
 * The reply check asked for words the rest of the system does not speak.
 *
 * The Stop hook sends `trigger: ['respond', 'report']`, and both ends of the check — the
 * machine deciding whether to start a judge, and the server picking which rules it reads —
 * compared that against a rule's tags verbatim. Neither word was in TRIGGER_TAG_ALIASES, so
 * saving a rule tagged `trigger:respond` drew a "nothing will ever ask for this" warning,
 * and a rule tagged the way people actually tag a rule about replies (`trigger:reply`,
 * `trigger:language`) was accepted, stored, and never selected.
 *
 * Measured 2026-09-28 on the test account's cached bundle: 0 of 40 selectors could be
 * reached by a reply, so the judge the whole IR-160 migration built never started once. And
 * nothing said so — no selector matching returns `none`, which is also what a checked,
 * clean turn looks like.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

/** Whatever the Stop hook actually sends, read from the hook rather than restated here. */
function replyLintTrigger() {
  const src = fs.readFileSync(path.join(repoRoot, 'hooks', 'ownmind-reply-lint.js'), 'utf8');
  const m = src.match(/trigger:\s*\[([^\]]*)\]/);
  assert.ok(m, 'ownmind-reply-lint.js no longer passes an array trigger; update this test');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

const REPLY_TRIGGER = replyLintTrigger();

// Verbatim tags of the account's rule "回我話要用白話中文，不要中英夾雜，術語要先解釋".
const PLAIN_CHINESE_TAGS = ['trigger:reply', 'trigger:language'];

const ctx = { assistantText: '好，我幫你查一下', userPrompts: ['ownmind 還有要修嗎'], repoRemote: null };

function selectedByServer(tags) {
  const rule = { id: 854, type: 'iron_rule', title: 't', content: 'c', tags, metadata: {} };
  return selectRules([rule], { ...ctx, trigger: REPLY_TRIGGER }).selected.length === 1;
}

function startsJudgeHere(tags) {
  return anySelectorMatches([{ tags, keywords: [], always_check: false, repo_match: '' }],
    { ...ctx, trigger: REPLY_TRIGGER });
}

test('every word the reply check asks for is one the vocabulary knows', () => {
  for (const word of REPLY_TRIGGER) {
    assert.ok(KNOWN_TRIGGER_WORDS.has(word), `reply check asks for "${word}", which no rule can be told to use`);
  }
});

test('a rule tagged the way a reply rule is actually tagged starts the judge on this machine', () => {
  assert.equal(startsJudgeHere(PLAIN_CHINESE_TAGS), true);
});

test('the server selects the same rule for judging', () => {
  assert.equal(selectedByServer(PLAIN_CHINESE_TAGS), true);
});

test('those tags no longer draw the "nothing asks for this" warning when saved', () => {
  assert.deepEqual(unknownTriggerTags(PLAIN_CHINESE_TAGS), []);
});

test('both ends agree on every word the reply check honours', () => {
  const words = new Set(REPLY_TRIGGER.flatMap((t) => TRIGGER_TAG_ALIASES[t] || [t]));
  assert.ok(words.size > REPLY_TRIGGER.length, 'the reply trigger should expand through the alias table');
  for (const word of words) {
    const tags = [`trigger:${word}`];
    assert.equal(startsJudgeHere(tags), true, `${word} should start the judge`);
    assert.equal(selectedByServer(tags), true, `${word} should be selected by the server`);
  }
});

test('the judge is not spent on rules about other operations', () => {
  // A reply costs the user's own quota on every checked turn. `trigger:command` means "every
  // shell command", not "every reply" — ruleMatchesTrigger's catch-all must not leak in here.
  for (const tags of [['trigger:command'], ['trigger:deploy'], ['trigger:edit'], []]) {
    assert.equal(startsJudgeHere(tags), false, `${JSON.stringify(tags)} must not start the judge`);
    assert.equal(selectedByServer(tags), false, `${JSON.stringify(tags)} must not be selected`);
  }
});

test('matching is case-insensitive, as the save-time vocabulary check is', () => {
  assert.equal(startsJudgeHere(['trigger:Reply']), true);
  assert.equal(selectedByServer(['trigger:Reply']), true);
});
