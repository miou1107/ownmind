import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectRules } from '../src/lib/enforcement/select-rules.js';
import { buildJudgeMessages, normaliseVerdicts } from '../src/lib/enforcement/judge-prompt.js';

/**
 * Which rules get judged, and how the judge is asked.
 *
 * Selection is the most fragile part of the whole feature: a rule that is not selected is a
 * rule that is not enforced, and it fails silently - the metric that should show it ("nothing
 * was selected") is indistinguishable from a quiet, correct turn. So the bias is towards
 * over-selection, with a token budget rather than a relevance threshold as the only limit,
 * and what was considered is recorded by the caller.
 */

const ALWAYS = {
  id: 125, type: 'iron_rule', code: 'IR-125', title: 'conclusion first',
  content: 'Talk to the owner conclusion-first.', tags: ['trigger:always'],
  metadata: { enforcement: { always_check: true } },
};
const KEYWORD = {
  id: 412, type: 'team_standard', title: 'ci ownership',
  content: 'Only the colleague may edit ci/.', tags: [],
  metadata: { enforcement: { keywords: ['FAPA', 'onboarding'] } },
};
const REPO = {
  id: 500, type: 'team_standard', title: 'monorepo scope',
  content: 'Only touch your own subproject.', tags: [],
  metadata: { enforcement: { guard: { repo_match: 'shared-monorepo', paths: ['ci/**'] } } },
};
const TAGGED = {
  id: 3, type: 'iron_rule', code: 'IR-003', title: 'reproduction test first',
  content: 'Write the failing test before the fix.', tags: ['trigger:edit'],
  metadata: {},
};
const UNRELATED = {
  id: 999, type: 'iron_rule', code: 'IR-999', title: 'deploy only with approval',
  content: 'Ask before deploying.', tags: ['trigger:deploy'], metadata: {},
};

const CTX = {
  assistantText: '', userPrompts: [], repoRemote: null, toolsUsed: [], trigger: '',
};

test('an always_check rule is selected with no contextual match at all', () => {
  const { selected } = selectRules([ALWAYS, UNRELATED], CTX);
  assert.deepEqual(selected.map((r) => r.id), [125]);
});

test('a keyword in the user prompt selects the rule', () => {
  const { selected } = selectRules([KEYWORD], { ...CTX, userPrompts: ['把 ownmind 搬到 FAPA'] });
  assert.deepEqual(selected.map((r) => r.id), [412]);
});

test('a keyword only in what the assistant said also selects it', () => {
  // The 2026-08-13 violation was in the assistant's own words, not in the question.
  const { selected } = selectRules([KEYWORD], { ...CTX, assistantText: 'stage 0 of the FAPA move' });
  assert.deepEqual(selected.map((r) => r.id), [412]);
});

test('being in the guarded repo selects the rule without any keyword', () => {
  const { selected } = selectRules([REPO], {
    ...CTX, repoRemote: 'https://example.com/shared-monorepo.git',
  });
  assert.deepEqual(selected.map((r) => r.id), [500]);
});

test('an un-annotated rule is selected by its trigger tag', () => {
  // "All rules" was the instruction. Selecting only annotated rules would cover two of a
  // hundred and fifty on day one and report every other turn as a normal quiet one.
  const { selected } = selectRules([TAGGED, UNRELATED], { ...CTX, trigger: 'edit' });
  assert.deepEqual(selected.map((r) => r.id), [3]);
});

test('a rule whose tag does not match this turn is left out', () => {
  const { selected } = selectRules([UNRELATED], { ...CTX, trigger: 'edit' });
  assert.deepEqual(selected, []);
});

// v1.26.171 — the reply-lint hook sends trigger as an ARRAY (a reply is both a respond and a
// report). Interpolating that array into `trigger:${trigger}` produced "trigger:respond,report",
// which matches no tag: measured on the live bundle, 6 of 310 rules were ever judged.
test('an array trigger selects a rule tagged with any of its elements', () => {
  const respondRule = { ...TAGGED, id: 21, tags: ['trigger:respond'] };
  const { selected } = selectRules([respondRule, UNRELATED], {
    ...CTX, trigger: ['respond', 'report'],
  });
  assert.deepEqual(selected.map((r) => r.id), [21]);
});

test('an array trigger with no matching element selects nothing but always-rules', () => {
  const respondRule = { ...TAGGED, id: 21, tags: ['trigger:respond'] };
  const { selected } = selectRules([respondRule, ALWAYS], {
    ...CTX, trigger: ['deploy', 'git'],
  });
  assert.deepEqual(selected.map((r) => r.id), [125]);
});

test('always-tagged rules survive the budget ahead of tag matches', () => {
  // The trap found in review: fixing the array match alone floods the candidate list, the
  // sort is rank-then-id, and the always-rules — the only ones enforced for months — would
  // be the ones evicted. They must rank with always_check, not with ordinary tag matches.
  const alwaysRules = Array.from({ length: 3 }, (_, i) => ({
    ...TAGGED, id: 900 + i, tags: ['trigger:always'], metadata: {},
  }));
  const tagRules = Array.from({ length: 6 }, (_, i) => ({
    ...TAGGED, id: 10 + i, tags: ['trigger:respond'],
  }));
  const { selected, dropped } = selectRules([...tagRules, ...alwaysRules], {
    ...CTX, trigger: ['respond'],
  }, { maxRules: 4 });
  const ids = selected.map((r) => r.id);
  assert.ok([900, 901, 902].every((id) => ids.includes(id)),
    `every always-rule must be selected, got ${ids}`);
  assert.equal(selected.length, 4);
  assert.equal(dropped.length, 5, 'the evicted tag matches are recorded, not lost');
});

test('the count budget never evicts a rank-0 rule, even when they alone exceed it', () => {
  // The live bundle has 7 trigger:always rules and the default count budget is 6. Without
  // this exemption the highest-id always-rule is evicted every single turn, forever — a
  // standing instruction delivered and never enforced, which is the incident this whole
  // change exists to close. Only the char budget may drop a rank-0 rule, and that drop is
  // recorded.
  const seven = Array.from({ length: 7 }, (_, i) => ({
    ...TAGGED, id: 800 + i, tags: ['trigger:always'], metadata: {},
  }));
  const { selected, dropped, budgetExceeded } = selectRules(seven, CTX, { maxRules: 6 });
  assert.equal(selected.length, 7, 'all seven always-rules must be judged');
  assert.deepEqual(dropped, []);
  assert.equal(budgetExceeded, false);
});

test('fragments are merged into the text the judge will read', () => {
  // A prohibition list often lives in a fragment. Sending the summary alone hands the judge a
  // standard with its prohibitions removed, which is the exact shape of the incident.
  const fragmented = {
    ...KEYWORD, id: 600, content: 'summary only',
    fragments: [{ title: 'forbidden list', content: 'never edit ci/projects.yml' }],
  };
  const { selected } = selectRules([fragmented], { ...CTX, userPrompts: ['FAPA'] });
  assert.match(selected[0].judgeText, /summary only/);
  assert.match(selected[0].judgeText, /never edit ci\/projects\.yml/);
});

test('the budget caps the count and says it was exceeded', () => {
  // Tag matches, not always-rules: rank-0 is exempt from the count budget (v1.26.171), so
  // the cap this asserts only exists for contextual matches.
  const many = Array.from({ length: 20 }, (_, i) => ({ ...TAGGED, id: 100 + i }));
  const { selected, budgetExceeded } = selectRules(many, { ...CTX, trigger: 'edit' }, { maxRules: 6 });
  assert.equal(selected.length, 6);
  assert.equal(budgetExceeded, true);
});

test('one oversized rule is skipped, and does not take the rest with it', () => {
  // Ending the loop at the first rule that does not fit would let a single long standard
  // silently remove every rule after it from scope, and the only visible symptom would be a
  // turn that reported nothing to check.
  const huge = { ...ALWAYS, id: 700, content: 'x'.repeat(30_000) };
  const { selected, dropped, budgetExceeded } = selectRules([huge, ALWAYS], CTX, { maxChars: 1000 });
  assert.deepEqual(selected.map((r) => r.id), [125], 'the rule that fits must still be judged');
  assert.deepEqual(dropped, [700], 'the rule that did not fit has to be recorded, not lost');
  assert.equal(budgetExceeded, true);
});

test('an empty rule set yields the same shape as every other return', () => {
  // Not just "no crash": the caller reads `dropped`, and an early exit that leaves it out
  // throws only for an account with no rules yet, which is the population least likely to
  // say anything about it.
  const expected = { selected: [], dropped: [], budgetExceeded: false };
  assert.deepEqual(selectRules([], CTX), expected);
  assert.deepEqual(selectRules(null, CTX), expected);
});

test('every return carries the same keys', () => {
  const shapes = [
    selectRules([], CTX),
    selectRules([ALWAYS], CTX),
    selectRules(Array.from({ length: 20 }, (_, i) => ({ ...ALWAYS, id: 200 + i })), CTX),
  ].map((r) => Object.keys(r).sort().join(','));
  assert.equal(new Set(shapes).size, 1, `return shapes drifted: ${shapes.join(' | ')}`);
});

test('the prompt carries each rule id, title and full text, plus the reply to audit', () => {
  const rules = [{ id: 412, title: 'ci ownership', judgeText: 'Only the colleague may edit ci/.' }];
  const messages = buildJudgeMessages({
    rules, assistantText: 'I will edit ci/projects.yml', userPrompts: ['move to FAPA'],
  });
  const all = messages.map((m) => m.content).join('\n');
  assert.match(all, /412/);
  assert.match(all, /ci ownership/);
  assert.match(all, /Only the colleague may edit/);
  assert.match(all, /I will edit ci\/projects\.yml/);
  assert.match(all, /move to FAPA/);
});

test('the judge is told to quote evidence and to default to not-violated', () => {
  const messages = buildJudgeMessages({ rules: [{ id: 1, title: 't', judgeText: 'r' }], assistantText: 'x' });
  const all = messages.map((m) => m.content).join('\n').toLowerCase();
  assert.match(all, /quote/);
  assert.match(all, /uncertain/);
  // A reply that cites a rule in order to comply with it must not be read as breaking it.
  assert.match(all, /comply/);
});

test('the parsed object callLLMSwitch returns is accepted as-is', () => {
  const { verdicts, parseFailed } = normaliseVerdicts({
    verdicts: [{ ruleId: 412, violated: true, evidence: 'I will edit ci/projects.yml', fix: 'open an issue' }],
  });
  assert.equal(parseFailed, false);
  assert.equal(verdicts[0].violated, true);
});

test('a bare string is a failure, not a clean result', () => {
  // Guards the mistake the first draft made: treating callLLMSwitch's return value as text.
  assert.equal(normaliseVerdicts('{"verdicts":[]}').parseFailed, true);
});

test('a shape with no verdicts array is a failure, never clean', () => {
  for (const bad of [{ answer: 'fine' }, null, undefined, 42]) {
    assert.equal(normaliseVerdicts(bad).parseFailed, true);
  }
});

test('an empty verdict list is clean, not a failure', () => {
  const { verdicts, parseFailed } = normaliseVerdicts({ verdicts: [] });
  assert.equal(parseFailed, false);
  assert.deepEqual(verdicts, []);
});

test('a violation claimed without a quote is dropped', () => {
  // An unevidenced claim is an assertion. Letting it through would inflate the false-positive
  // rate the pilot is measured on with findings nobody can check.
  const { verdicts } = normaliseVerdicts({
    verdicts: [{ ruleId: 412, violated: true, evidence: '   ', fix: 'x' }],
  });
  assert.deepEqual(verdicts, []);
});
