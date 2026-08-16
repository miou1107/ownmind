import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';
import { editReminder } from '../hooks/ownmind-edit-reminder.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The guard, in the module both installed hooks actually call.
 *
 * It lives in `ownmind-edit-reminder.js` rather than in `ownmind-iron-rule-check.js` because
 * of what is registered: `install.sh` passes `--bash`, `ensure-pretooluse-hooks.cjs` turns
 * that into the `.sh`, and the `.sh` hands every edit tool to this module and exits. A guard
 * written into the `.js` hook would never run on macOS or Linux - it would pass its unit
 * tests, ship, and block nothing on the machine it was written for.
 *
 * So the last test here spawns the real `.sh` against a throwaway HOME. That is the only one
 * that can tell whether the guard is wired into the path Claude Code actually takes.
 */

const GUARD = {
  id: 412,
  title: 'ci ownership belongs to the colleague',
  repo_match: 'edit-guard-fixture',
  paths: ['ci/**'],
  owner: 'Colleague',
};

function makeRepo() {
  const dir = tempDir('om-editguard-edit-guard-fixture-');
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://example.com/edit-guard-fixture.git']);
  return dir;
}

function touch(repo, relPath) {
  const full = path.join(repo, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, 'x\n');
  return full;
}

const BASE = { version: 'test', apiKey: '', apiUrl: '', now: Date.now(), sessionId: 's1' };

test('editing a guarded path returns a block envelope', async () => {
  const repo = makeRepo();
  const out = await editReminder({
    ...BASE, filePath: touch(repo, 'ci/projects.yml'), guards: [GUARD],
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.decision, 'block');
  assert.match(parsed.reason, /412/);
  assert.match(parsed.reason, /Colleague/);
});

test('editing an allowed path in the same repo is not blocked', async () => {
  const repo = makeRepo();
  const out = await editReminder({
    ...BASE, filePath: touch(repo, 'README.md'), guards: [GUARD],
  });
  const parsed = out ? JSON.parse(out) : {};
  assert.notEqual(parsed.decision, 'block');
});

test('the block fires every time, not once an hour like the reminder', async () => {
  // The listing above it is throttled on purpose. A guard that inherited that throttle would
  // permit the second attempt within the hour, which is not a guarantee - it is a delay.
  const repo = makeRepo();
  const args = { ...BASE, filePath: touch(repo, 'ci/projects.yml'), guards: [GUARD] };
  assert.equal(JSON.parse(await editReminder(args)).decision, 'block');
  assert.equal(JSON.parse(await editReminder(args)).decision, 'block');
});

test('a plan written at a legal path, proposing the forbidden edit, is flagged', async () => {
  // What the incident actually produced. The file is somewhere perfectly ordinary; the text
  // is what breaks the rule, so a guard reading only `file_path` never sees it.
  const repo = makeRepo();
  const out = await editReminder({
    ...BASE,
    filePath: touch(repo, 'docs/plan.md'),
    content: 'Stage 0: I will add an entry to ci/projects.yml and write ci/mine/.gitlab-ci.yml.',
    guards: [GUARD],
  });
  const parsed = JSON.parse(out);
  assert.notEqual(parsed.decision, 'block', 'a document is not the edit itself');
  assert.match(parsed.hookSpecificOutput.additionalContext, /412/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /ci\//);
});

test('an ordinary document is left alone', async () => {
  const repo = makeRepo();
  const out = await editReminder({
    ...BASE,
    filePath: touch(repo, 'docs/notes.md'),
    content: 'Some notes about the release schedule.',
    guards: [GUARD],
  });
  const parsed = out ? JSON.parse(out) : {};
  assert.notEqual(parsed.decision, 'block');
  assert.doesNotMatch(JSON.stringify(parsed), /412/);
});

test('no guards means no blocking, and no crash', async () => {
  const repo = makeRepo();
  const out = await editReminder({ ...BASE, filePath: touch(repo, 'ci/projects.yml'), guards: [] });
  const parsed = out ? JSON.parse(out) : {};
  assert.notEqual(parsed.decision, 'block');
});

/** Point `os.homedir()` at a throwaway tree for the duration of one call. */
async function withHome(home, fn) {
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test('a cache file that cannot be read is reported, not treated as "no rules"', async () => {
  // The failure this notice was written for, and the one that does not throw.
  // `readEnforcementBundle` catches every read and parse error and answers with an empty
  // bundle, so a corrupt cache arrives as `guards: []` - indistinguishable from an account
  // with nothing annotated, and invisible to any `catch`. The first version of this notice
  // only fired on a malformed guard object, which is not what the commit claimed to fix.
  const home = tempDir('om-editguard-corrupt-');
  fs.mkdirSync(path.join(home, '.ownmind', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ownmind', 'cache', 'enforcement.json'), '{ this is not json');

  const repo = makeRepo();
  const out = await withHome(home, () => editReminder({
    ...BASE, filePath: touch(repo, 'ci/projects.yml'), guards: null,
  }));
  assert.ok(out, 'a machine whose rules cannot be read must not be silent');
  const parsed = JSON.parse(out);
  assert.notEqual(parsed.decision, 'block', 'an unreadable cache must not stop the edit');
  assert.match(parsed.hookSpecificOutput.additionalContext, /could not check/i);
});

test('a machine that has simply never synced is not nagged on every edit', async () => {
  // The other side of it. No cache file at all is an ordinary first run, not a broken one,
  // and a brand new account is the population least willing to be told so on every keystroke.
  const home = tempDir('om-editguard-nosync-');
  fs.mkdirSync(path.join(home, '.ownmind'), { recursive: true });

  const repo = makeRepo();
  const out = await withHome(home, () => editReminder({
    ...BASE, filePath: touch(repo, 'ci/projects.yml'), guards: null,
  }));
  const text = out ? JSON.parse(out).hookSpecificOutput?.additionalContext || '' : '';
  assert.doesNotMatch(text, /could not check/i);
});

test('a guard that cannot run says so instead of going quiet', async () => {
  // Failing open is the right call - a broken guard must not stop somebody editing files.
  // Doing it silently is not: the edit lands, nothing is said, and a protection that is off
  // looks exactly like a protection that ran and found nothing. This file already carries
  // that argument for the state directory; the guard is the part where it matters most.
  const repo = makeRepo();
  const exploding = { id: 412, get paths() { throw new Error('bundle is unreadable'); } };
  const out = await editReminder({
    ...BASE, filePath: touch(repo, 'ci/projects.yml'), guards: [exploding],
  });
  const parsed = JSON.parse(out);
  assert.notEqual(parsed.decision, 'block', 'a broken guard must not block the edit');
  assert.match(
    parsed.hookSpecificOutput.additionalContext, /could not check/i,
    'the failure has to reach the user, not just the exit code',
  );
});

test('the shell hook Claude Code registers carries the block through to stdout', async () => {
  // The end-to-end check, and the one that matters most: it is the only test that fails if
  // the guard is wired into the wrong file.
  const repo = makeRepo();
  const file = touch(repo, 'ci/projects.yml');
  const home = tempDir('om-editguard-home-');

  // Stage the pieces the .sh reaches for by absolute path under $HOME.
  const hooksDir = path.join(home, '.ownmind', 'hooks');
  fs.mkdirSync(path.join(hooksDir, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(home, '.ownmind', 'cache'), { recursive: true });
  fs.mkdirSync(path.join(home, '.ownmind', 'shared'), { recursive: true });
  for (const rel of ['hooks/ownmind-edit-reminder.js', 'hooks/lib', 'shared', 'package.json']) {
    const target = path.join(repoRoot, rel);
    const link = path.join(home, '.ownmind', rel.startsWith('hooks/') ? rel : rel);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    if (!fs.existsSync(link)) fs.symlinkSync(target, link);
  }
  fs.writeFileSync(
    path.join(home, '.ownmind', 'cache', 'enforcement.json'),
    JSON.stringify({ selectors: [], guards: [GUARD], injectables: [] }),
  );

  const payload = JSON.stringify({
    tool_name: 'Edit',
    session_id: 's-e2e',
    tool_input: { file_path: file },
  });

  const stdout = execFileSync('bash', [path.join(repoRoot, 'hooks', 'ownmind-iron-rule-check.sh')], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
    timeout: 30_000,
  });

  assert.match(
    stdout, /"decision"\s*:\s*"block"/,
    'the guard did not reach stdout through the hook Claude Code actually runs',
  );
  assert.match(stdout, /412/);
});
