/**
 * What the user and the assistant are each told when a verdict lands a turn late.
 *
 * Four states, and the plan named all four before any of this was written, because the one
 * that goes wrong quietly is "the judge did not run" arriving as silence — which is exactly
 * what "the reply was fine" looks like.
 *
 * The states that only exist because verdicts can arrive late or not at all — several waiting
 * at once, a judge that vanished, an account with checking off — live in
 * tests/reply-check-turn-identity.test.js alongside the keying that made them possible.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.js';
import { collectVerdict } from '../hooks/lib/verdict-collect.js';
import { _logPathForTests } from '../hooks/lib/check-failure-log.js';

// Every case here injects its own logFailure, so nothing should reach the real file — but a
// case added later would, and the target is the developer's own diagnosis log.
_logPathForTests(path.join(tempDir('om-verdict-collect-log-'), 'check-failures.jsonl'));

const ORIGINAL_FORCE = process.env.OWNMIND_LOCALE_FORCE;
process.env.OWNMIND_LOCALE_FORCE = 'en';
process.on('exit', () => {
  if (ORIGINAL_FORCE === undefined) delete process.env.OWNMIND_LOCALE_FORCE;
  else process.env.OWNMIND_LOCALE_FORCE = ORIGINAL_FORCE;
});

/** One verdict waiting, and a collector wired to nothing on disk. */
const waiting = (record) => ({
  sessionId: 's1',
  list: () => [{ turnId: 't1', record }],
  // Including the second look the deadline branch takes. An unstubbed one reads the
  // developer's own ~/.ownmind/state, which makes the answer depend on whose machine this is.
  reread: () => record,
  remove: () => {},
  sweep: () => {},
  logFailure: () => {},
  // The real throttle speaks every state notice and announces recovery only after a failure.
  speak: (key) => key !== null,
});

test('nothing waiting costs nothing', async () => {
  // The common case: the judge is still running, or this turn was never judged.
  assert.deepEqual(
    await collectVerdict({ sessionId: 's1', list: () => [], sweep: () => {} }),
    { action: 'none' },
  );
});

test('a clean verdict says nothing', async () => {
  const out = await collectVerdict(waiting({ outcome: 'clean', violations: [] }));
  assert.equal(out.action, 'none', 'silence is the everyday path and must stay free');
});

test('a violation tells the user, and tells the assistant to act on it', async () => {
  const out = await collectVerdict(waiting({
    outcome: 'violation',
    reply_excerpt: '我先看了 A 檔案',
    violations: [{
      ruleId: 795, ruleCode: 'IR-XXX', ruleTitle: '先講結論',
      evidence: '我先看了 A 檔案', fix: '第一句改成結論。',
    }],
  }));

  assert.equal(out.action, 'notice');
  assert.match(out.banner, /breaks 1 of your rules/);
  assert.match(out.banner, /先講結論/, 'the user is told which rule, by its own name');
  assert.match(out.banner, /reminder, not a block/,
    'this path arrives after the reply was read; it cannot stop anything');

  assert.match(out.forAssistant, /先講結論/);
  assert.match(out.forAssistant, /我先看了 A 檔案/, 'the quote, so it can see what it did');
  assert.match(out.forAssistant, /not a request to apologise/,
    'the failure mode a bare finding produces is a paragraph of self-criticism');
  assert.match(out.forAssistant, /Do not restate the finding/,
    'the user has already been shown it; saying it twice is worse than once');
});

test('a judge that did not run is loud, and the user line carries no jargon', async () => {
  const out = await collectVerdict(waiting({
    outcome: 'failed', failure: 'timeout', reason: 'the judge did not answer within 90000ms',
  }));

  assert.equal(out.action, 'notice');
  assert.match(out.banner, /could not check/);
  assert.match(out.banner, /update script/, 'and what repairs it');
  for (const jargon of ['no-cli', 'timeout', 'unparseable', 'exit']) {
    assert.doesNotMatch(out.banner, new RegExp(jargon),
      `"${jargon}" is internal vocabulary and must not reach the user`);
  }
  assert.match(out.forAssistant, /timeout/, 'the assistant gets the detail the user line drops');
});

test('a rejected key says sign in again, not "try later"', async () => {
  // Waiting fixes an outage and never fixes a revoked key. They ask different things of the
  // user, so they cannot share a sentence — or a throttle key, which would read the move
  // between them as "no change, stay quiet".
  const out = await collectVerdict(waiting({
    outcome: 'failed', failure: 'unauthorized', reason: 'http 401',
  }));
  assert.match(out.banner, /sign in again/);
});

test('a violation list that arrived empty is not announced as a violation', async () => {
  // Defensive: a verdict file that says violation with nothing in it is a bug somewhere
  // upstream, and announcing "a rule was broken" with no rule named is worse than silence.
  const out = await collectVerdict(waiting({ outcome: 'violation', violations: [] }));
  assert.equal(out.action, 'none');
});

test('the false-alarm handle rides with the finding', async () => {
  // Without it the false-positive rate cannot be counted, and that rate is the stated
  // threshold for turning enforcement on for anybody besides its author.
  const out = await collectVerdict(waiting({
    outcome: 'violation',
    check_id: 4321,
    violations: [{ ruleId: 795, ruleTitle: '先講結論', evidence: 'x', fix: 'y' }],
  }));
  assert.match(out.banner, /4321/);
  assert.match(out.forAssistant, /ownmind_report_check_feedback/,
    'a handle nothing records is a question asked into the void');
});

test('a team standard tells the AI the user cannot simply waive it', async () => {
  // Carried over from the synchronous path, which said this and which this replaced. A team
  // standard belongs to the company; the person in the conversation is exactly the one who
  // cannot lift it, and an AI that does not know that gets talked out of it by them.
  const out = await collectVerdict(waiting({
    outcome: 'violation',
    violations: [{
      ruleId: 412, ruleType: 'team_standard', ruleTitle: 'ci ownership',
      evidence: 'I will add an entry to ci/projects.yml', fix: 'open an issue for the colleague',
    }],
  }));
  assert.match(out.forAssistant, /team standard/i);
  assert.match(out.forAssistant, /確認/);
});

test('the user\'s own rule does not demand a confirmation', async () => {
  const out = await collectVerdict(waiting({
    outcome: 'violation',
    violations: [{
      ruleId: 125, ruleType: 'iron_rule', ruleCode: 'IR-125', ruleTitle: 'conclusion first',
      evidence: 'First let me walk you through what I searched', fix: 'lead with the conclusion',
    }],
  }));
  assert.match(out.forAssistant, /IR-125/);
  assert.ok(!out.forAssistant.includes('確認'), 'the user does not confirm to waive their own rule');
});

test('checking coming back is announced once, after it had been down', async () => {
  // Not decoration: the throttle has to be told the state is healthy again, or it stays stuck
  // on the last failure key and suppresses the NEXT failure of the same kind as "no change".
  const out = await collectVerdict({
    ...waiting({ outcome: 'clean', violations: [] }),
    speak: (key) => key === null,
  });
  assert.equal(out.action, 'notice');
  assert.match(out.banner, /checking the AI's replies against your rules again/);
});
