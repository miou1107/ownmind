// #20, with the fixture finally correct.
// The commit trigger lives at metadata.verification.trigger (an array), not in tags —
// which is why my first two attempts never selected the rule and everything fell to the
// baseline. isSecretGuardRule keys on conditions.type === 'staged_files_exclude'.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { fileURLToPath } from 'node:url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const S = fs.mkdtempSync(path.join(os.tmpdir(), 'om-repro-'));
fs.rmSync(S, { recursive: true, force: true }); fs.mkdirSync(S, { recursive: true });

let n = 0;
const rule = (block) => ({
  id: 9001, user_id: 1, type: 'iron_rule', code: 'IR-002', title: '不要 commit .env 或密碼',
  status: 'active', tier: 'default', content: 'x', tags: [],
  metadata: {
    verification: {
      trigger: ['commit'],
      mode: 'pre_action',
      compliance_event: null,
      conditions: { type: 'staged_files_exclude', params: { patterns: ['*.secret'] }, message: 'staged 包含敏感檔案' },
      ...(block === undefined ? {} : { block_on_fail: block }),
    },
  },
});

for (const [label, rules] of [
  ['對照組：機密規矩設成「要擋」', [rule(true)]],
  ['問題組：機密規矩設成「不擋」', [rule(false)]],
  ['問題組：機密規矩沒設擋不擋', [rule(undefined)]],
]) {
  const d = path.join(S, `repo${n += 1}`);
  fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q', d]);
  // conf.env does NOT match the rule's own pattern (*.secret), so the only thing that can
  // stop this commit is the key inside the file.
  // AWS's own published documentation example, assembled at runtime. Nothing here is a live
  // credential, but the scanner under test cannot know that - it blocked this very file from
  // being committed when the value was written out as a literal, which is the behaviour the
  // script exists to measure.
  const fakeKey = `AKIA${'IOSFODNN7'}${'EXAMPLE'}`;
  fs.writeFileSync(path.join(d, 'conf.env'), `AWS_ACCESS_KEY_ID=${fakeKey}\n`);
  execFileSync('git', ['-C', d, 'add', 'conf.env']);

  const h = path.join(S, `h${n}`);
  fs.mkdirSync(path.join(h, '.ownmind/cache'), { recursive: true });
  fs.cpSync(path.join(os.homedir(), '.ownmind/scripts'), path.join(h, '.ownmind/scripts'), { recursive: true });
  fs.cpSync(path.join(os.homedir(), '.ownmind/shared'), path.join(h, '.ownmind/shared'), { recursive: true });
  fs.writeFileSync(path.join(h, '.ownmind/cache/iron_rules.json'), JSON.stringify(rules));

  const r = spawnSync('node', [path.join(REPO, 'hooks/ownmind-git-pre-commit.js')],
    { cwd: d, env: { ...process.env, HOME: h }, encoding: 'utf8' });
  const code = r.status;
  const out = `${r.stdout || ''}${r.stderr || ''}`;

  console.log(`\n--- ${label} → ${code === 1 ? '擋住' : '放行（金鑰進得去）'} ---`);
  console.log((out.trim() || '(沒有輸出)').split('\n').map((l) => '    ' + l).join('\n'));
}

fs.rmSync(S, { recursive: true, force: true });
