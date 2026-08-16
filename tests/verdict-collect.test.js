/**
 * What the user and the assistant are each told when a verdict lands a turn late.
 *
 * Four states, and the plan named all four before any of this was written, because the one
 * that goes wrong quietly is "the judge did not run" arriving as silence — which is exactly
 * what "the reply was fine" looks like.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectVerdict } from '../hooks/lib/verdict-collect.js';

const ORIGINAL_FORCE = process.env.OWNMIND_LOCALE_FORCE;
process.env.OWNMIND_LOCALE_FORCE = 'en';
process.on('exit', () => {
  if (ORIGINAL_FORCE === undefined) delete process.env.OWNMIND_LOCALE_FORCE;
  else process.env.OWNMIND_LOCALE_FORCE = ORIGINAL_FORCE;
});

const take = (verdict) => () => verdict;

test('nothing waiting costs nothing', async () => {
  // The common case: the judge is still running, or this turn was never judged.
  assert.deepEqual(await collectVerdict({ sessionId: 's1', take: take(null) }), { action: 'none' });
});

test('a clean verdict says nothing', async () => {
  const out = await collectVerdict({
    sessionId: 's1', take: take({ outcome: 'clean', violations: [] }),
  });
  assert.equal(out.action, 'none', 'silence is the everyday path and must stay free');
});

test('a violation tells the user it is handled, and tells the assistant to handle it', async () => {
  const out = await collectVerdict({
    sessionId: 's1',
    take: take({
      outcome: 'violation',
      violations: [{
        ruleId: 795, ruleCode: 'IR-XXX', ruleTitle: '先講結論',
        evidence: '我先看了 A 檔案', fix: '第一句改成結論。',
      }],
    }),
  });

  assert.equal(out.action, 'notice');
  assert.match(out.banner, /one of your rules was not met/);
  assert.match(out.banner, /先講結論/, 'the user is told which rule, by its own name');
  assert.match(out.banner, /Nothing for you to do/, 'and that it is already being handled');

  assert.match(out.forAssistant, /先講結論/);
  assert.match(out.forAssistant, /我先看了 A 檔案/, 'the quote, so it can see what it did');
  assert.match(out.forAssistant, /not a request to apologise/,
    'the failure mode a bare finding produces is a paragraph of self-criticism');
  assert.match(out.forAssistant, /Do not restate the finding/,
    'the user has already been shown it; saying it twice is worse than once');
});

test('a judge that did not run is loud, and the user line carries no jargon', async () => {
  const out = await collectVerdict({
    sessionId: 's1',
    take: take({ outcome: 'failed', failure: 'no-cli', reason: 'claude is not on this machine' }),
  });

  assert.equal(out.action, 'notice');
  assert.match(out.banner, /could not check/);
  assert.match(out.banner, /update script/, 'and what repairs it');
  for (const jargon of ['no-cli', 'timeout', 'unparseable', 'exit']) {
    assert.doesNotMatch(out.banner, new RegExp(jargon),
      `"${jargon}" is internal vocabulary and must not reach the user`);
  }
  assert.match(out.forAssistant, /no-cli/, 'the assistant gets the detail the user line drops');
});

test('a violation list that arrived empty is not announced as a violation', async () => {
  // Defensive: a verdict file that says violation with nothing in it is a bug somewhere
  // upstream, and announcing "a rule was broken" with no rule named is worse than silence.
  const out = await collectVerdict({
    sessionId: 's1', take: take({ outcome: 'violation', violations: [] }),
  });
  assert.equal(out.action, 'none');
});
