/**
 * The judge, running on this machine and on the user's own Claude Code subscription.
 *
 * WHY IT MOVED. The owner's standing instruction is that anything OwnMind asks a model to
 * decide is spent from the user's own subscription, never the llm switch. The quota lives on
 * the user's machine, so the judge has to as well. Separately, the switch path was failing
 * 474 of 1006 checks — measured directly, 6 of 12 gateway calls came back
 * `502 All 2 provider attempts failed`.
 *
 * WHAT IS MEASURED, not assumed, about the CLI this drives:
 *
 *   - `claude -p` answers headlessly and spends the subscription
 *   - a real judge payload (8 rules, a long reply) takes 18s on haiku and 43s on sonnet;
 *     about 10s of that is startup, because a bare "reply OK" takes 10.5s
 *   - a prompt beginning `---` is read as a FLAG. The first probe died on exactly that, which
 *     is why the prompt goes on stdin here and there is a test holding it there
 *
 * WHAT THESE TESTS ARE REALLY FOR. Every failure below has one shape in common: it must not
 * come back looking like a clean verdict. An empty violations list from a judge that never
 * ran is indistinguishable from a reply that broke no rules, and that is the exact lie this
 * product exists to remove.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.js';
import { judgeLocally } from '../hooks/lib/local-judge.js';

const RULES = [
  { id: 795, code: 'IR-XXX', title: '先講結論', judgeText: '第一句就是結論，不要報工作過程。' },
  { id: 412, type: 'team_standard', title: 'ci ownership', judgeText: 'Only the colleague may edit ci/.' },
];
const REPLY = '我先看了 A 檔案，又看了 B 檔案，跑了三次測試，最後發現問題在第 42 行。';

/**
 * A fake `claude` on PATH.
 *
 * A real one costs 18 seconds and the user's quota per call, so the wiring is proved against
 * a stand-in and the real CLI is exercised once, by hand, in the release check. The stand-in
 * records its argv and stdin so the tests can assert on what would have been sent.
 */
function fakeClaude({ stdout = '', exitCode = 0, delayMs = 0 }) {
  const dir = tempDir('om-fake-claude-');
  const record = path.join(dir, 'invocation.json');
  const bin = path.join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude');

  const script = `#!/usr/bin/env node
const fs = require('fs');
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), stdin }));
  setTimeout(() => {
    process.stdout.write(${JSON.stringify(stdout)});
    process.exit(${exitCode});
  }, ${delayMs});
});
`;
  if (process.platform === 'win32') {
    const js = path.join(dir, 'claude.js');
    fs.writeFileSync(js, script);
    fs.writeFileSync(bin, `@echo off\r\nnode "${js}" %*\r\n`);
  } else {
    fs.writeFileSync(bin, script, { mode: 0o755 });
  }
  return { dir, bin, invocation: () => JSON.parse(fs.readFileSync(record, 'utf8')) };
}

const verdictJson = (verdicts) => JSON.stringify({ verdicts });

test('a clean reply comes back clean, and the prompt never touches argv', async () => {
  const fake = fakeClaude({ stdout: verdictJson([{ ruleId: 795, violated: false, evidence: '', fix: '' }]) });
  const out = await judgeLocally({ rules: RULES, assistantText: REPLY, claudeBin: fake.bin });

  assert.equal(out.outcome, 'clean');
  assert.deepEqual(out.violations, []);

  const { argv, stdin } = fake.invocation();
  assert.ok(stdin.includes(REPLY), 'the reply goes on stdin');
  assert.ok(stdin.includes('第一句就是結論'), 'and so do the rules');
  assert.ok(!argv.some((a) => a.includes(REPLY)),
    'a prompt beginning --- is read as a flag; that is how the first probe died');
  assert.ok(argv.includes('-p') || argv.includes('--print'), 'headless');
});

test('it grants the judge no tools', async () => {
  // A judge that can edit files is not a judge. Also the fastest possible run: nothing to load.
  const fake = fakeClaude({ stdout: verdictJson([]) });
  await judgeLocally({ rules: RULES, assistantText: REPLY, claudeBin: fake.bin });
  const { argv } = fake.invocation();
  const i = argv.findIndex((a) => a === '--allowed-tools' || a === '--allowedTools');
  assert.notEqual(i, -1, 'tools must be named, not left to the default');
  assert.equal(argv[i + 1], '', 'and the list must be empty');
});

test('it runs the judge in safe mode, which is load-bearing twice over', async () => {
  // Found by running the real CLI, because a fake one cannot have an environment to inherit.
  //
  // Without --safe-mode the nested CLI loads the user's own CLAUDE.md, skills and hooks. Asked
  // to audit a reply against rule 795, it read 795 as applying to itself and answered
  // "問題在第 42 行。\n\n**Why I made the mistake:** …" — the assistant apologising rather than
  // the judge judging. It also marked a compliant reply as a violation. Both went away with
  // this flag.
  //
  // The second job is the one with no error message: OwnMind's Stop hook is registered
  // globally, so a judge launched from a Stop hook fires another Stop hook, which launches
  // another judge. This is what stops that.
  const fake = fakeClaude({ stdout: verdictJson([]) });
  await judgeLocally({ rules: RULES, assistantText: REPLY, claudeBin: fake.bin });
  const { argv } = fake.invocation();
  assert.ok(argv.includes('--safe-mode'),
    'without this the judge inherits the user environment and stops being a judge');
  assert.ok(argv.includes('--no-session-persistence'),
    'one session file per checked turn adds up, and none of them is worth resuming');
});

test('a violation is reported with the rule it belongs to', async () => {
  const fake = fakeClaude({
    stdout: verdictJson([
      { ruleId: 795, violated: true, evidence: '我先看了 A 檔案', fix: '第一句改成結論。' },
      { ruleId: 412, violated: false, evidence: '', fix: '' },
    ]),
  });
  const out = await judgeLocally({ rules: RULES, assistantText: REPLY, claudeBin: fake.bin });

  assert.equal(out.outcome, 'violation');
  assert.equal(out.violations.length, 1);
  assert.equal(out.violations[0].ruleId, 795);
  assert.equal(out.violations[0].ruleTitle, '先講結論', 'the title comes from the rule, not the model');
  assert.equal(out.violations[0].ruleCode, 'IR-XXX');
  assert.match(out.violations[0].evidence, /我先看了/);
});

test('a violation with no quote is dropped, not reported', async () => {
  // An unevidenced claim is an assertion. The server judge already drops these; the client one
  // has to agree, or moving the judging changes what counts as a finding.
  const fake = fakeClaude({
    stdout: verdictJson([{ ruleId: 795, violated: true, evidence: '   ', fix: 'x' }]),
  });
  const out = await judgeLocally({ rules: RULES, assistantText: REPLY, claudeBin: fake.bin });
  assert.equal(out.outcome, 'clean');
  assert.deepEqual(out.violations, []);
});

// --- Every way this can fail, and none of them may look clean ---

test('a non-zero exit is a failure, not an empty verdict list', async () => {
  const fake = fakeClaude({ stdout: '', exitCode: 1 });
  const out = await judgeLocally({ rules: RULES, assistantText: REPLY, claudeBin: fake.bin });
  assert.equal(out.outcome, 'failed');
  assert.equal(out.failure, 'exit');
  assert.deepEqual(out.violations, []);
  assert.ok(out.reason, 'and it says what happened, for the log');
});

test('an answer that is not JSON is a failure', async () => {
  const fake = fakeClaude({ stdout: 'The reply looks fine to me.' });
  const out = await judgeLocally({ rules: RULES, assistantText: REPLY, claudeBin: fake.bin });
  assert.equal(out.outcome, 'failed');
  assert.equal(out.failure, 'unparseable');
  assert.match(out.reason, /looks fine/, 'the excerpt goes in, so the next one is diagnosable');
});

test('JSON of the wrong shape is a failure, not silence', async () => {
  const fake = fakeClaude({ stdout: '{"ok":true}' });
  const out = await judgeLocally({ rules: RULES, assistantText: REPLY, claudeBin: fake.bin });
  assert.equal(out.outcome, 'failed');
  assert.equal(out.failure, 'unparseable');
});

test('a fenced answer is read, because models do that', async () => {
  const fake = fakeClaude({ stdout: '```json\n' + verdictJson([]) + '\n```' });
  const out = await judgeLocally({ rules: RULES, assistantText: REPLY, claudeBin: fake.bin });
  assert.equal(out.outcome, 'clean');
});

test('a judge that runs too long is stopped, and says so', async () => {
  const fake = fakeClaude({ stdout: verdictJson([]), delayMs: 3000 });
  const out = await judgeLocally({
    rules: RULES, assistantText: REPLY, claudeBin: fake.bin, timeoutMs: 300,
  });
  assert.equal(out.outcome, 'failed');
  assert.equal(out.failure, 'timeout');
  assert.match(out.reason, /300/, 'the budget it exceeded belongs in the message');
});

test('no claude on this machine is its own failure, with its own words', async () => {
  // Every OwnMind user is a Claude Code user, so this should be the empty set — which is
  // exactly why it would go unnoticed if it ever stopped being.
  const out = await judgeLocally({
    rules: RULES, assistantText: REPLY, claudeBin: '/nonexistent/claude',
  });
  assert.equal(out.outcome, 'failed');
  assert.equal(out.failure, 'no-cli');
  assert.notEqual(out.failure, 'exit', 'a missing CLI is not the same as a CLI that refused');
});

test('nothing to judge is not a judgement', async () => {
  // No rules applied. Spending 18 seconds and a slice of the user's quota to be told so is
  // waste, and calling it "clean" claims a check that never happened.
  const fake = fakeClaude({ stdout: verdictJson([]) });
  const out = await judgeLocally({ rules: [], assistantText: REPLY, claudeBin: fake.bin });
  assert.equal(out.outcome, 'skipped');
  assert.throws(() => fake.invocation(), 'the CLI must not have been launched at all');
});
