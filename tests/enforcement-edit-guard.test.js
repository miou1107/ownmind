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
 * It lives in `ownmind-edit-reminder.js` rather than in either hook, because both hooks call
 * it: the `.sh` hands every edit tool to that module and exits, and the `.js` reaches it
 * through its own edit branch. Which of the two a machine runs has changed once already —
 * `install.sh` passed `--bash` until v1.30.15 and macOS and Linux got the `.sh`; without it
 * every platform gets the `.js`.
 *
 * So the last two tests spawn the real hooks against a throwaway HOME, one each. They are the
 * only ones that can tell whether the guard is wired into the path Claude Code actually takes,
 * and keeping both means the answer does not depend on which wiring is current. Neither HOME
 * carries credentials, which is the other half of the same question: the guard reads the local
 * bundle and never the API, so a machine with no key configured has to be enforced too.
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

/**
 * Stage the pieces an installed hook reaches for by absolute path under a throwaway $HOME,
 * with the guard bundle already in the cache. Deliberately no credentials anywhere in it:
 * the guard reads the local bundle and needs none, and a hook that quietly requires one is
 * the bug `the node hook ... with no credentials` below exists to catch.
 */
function stageHome() {
  const home = tempDir('om-editguard-home-');
  fs.mkdirSync(path.join(home, '.ownmind', 'cache'), { recursive: true });
  // No mkdirSync for hooks/lib or shared: a real directory there is not a link, and the loop
  // below would skip creating one, leaving two of the four pieces unstaged while the code
  // read as if all four were.
  for (const rel of ['hooks/ownmind-edit-reminder.js', 'hooks/lib', 'shared', 'package.json']) {
    const link = path.join(home, '.ownmind', rel);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(repoRoot, rel), link);
  }
  fs.writeFileSync(
    path.join(home, '.ownmind', 'cache', 'enforcement.json'),
    JSON.stringify({ selectors: [], guards: [GUARD], injectables: [] }),
  );
  return home;
}

/** The env an installed hook runs under, with every route to a credential removed. */
function envWithoutCredentials(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.OWNMIND_API_KEY;
  delete env.OWNMIND_API_URL;
  return env;
}

test('the shell hook Claude Code registers carries the block through to stdout', async () => {
  // The end-to-end check, and the one that matters most: it is the only test that fails if
  // the guard is wired into the wrong file.
  const repo = makeRepo();
  const file = touch(repo, 'ci/projects.yml');
  const home = stageHome();

  const payload = JSON.stringify({
    tool_name: 'Edit',
    session_id: 's-e2e',
    tool_input: { file_path: file },
  });

  const stdout = execFileSync('bash', [path.join(repoRoot, 'hooks', 'ownmind-iron-rule-check.sh')], {
    input: payload,
    encoding: 'utf8',
    env: envWithoutCredentials(home),
    timeout: 30_000,
  });

  assert.match(
    stdout, /"decision"\s*:\s*"block"/,
    'the guard did not reach stdout through the hook Claude Code actually runs',
  );
  assert.match(stdout, /412/);
});

test('the node hook Claude Code registers blocks with no credentials on the machine', () => {
  // The twin of the test above, for the file that is actually registered now. From v1.30.15
  // `install.sh` stopped passing `--bash`, so `ensure-pretooluse-hooks.cjs` writes
  // `node "<dir>/hooks/ownmind-iron-rule-check.js"` on every platform and the .sh above
  // guards a path nothing executes any more.
  //
  // No credentials in the HOME and none in the env, on purpose. The guard reads the local
  // enforcement bundle and never the API, so a machine with no key configured is still
  // meant to be enforced - the same reasoning the .sh states over its action gate. When the
  // credentials check sat in front of the edit branch, this edit went through in silence:
  // no block, and not even the "could not check" line.
  const repo = makeRepo();
  const file = touch(repo, 'ci/projects.yml');
  const home = stageHome();

  const stdout = execFileSync('node', [path.join(repoRoot, 'hooks', 'ownmind-iron-rule-check.js')], {
    input: JSON.stringify({ tool_name: 'Edit', session_id: 's-e2e-node', tool_input: { file_path: file } }),
    encoding: 'utf8',
    env: envWithoutCredentials(home),
    timeout: 30_000,
  });

  assert.match(
    stdout, /"decision"\s*:\s*"block"/,
    'the guard did not reach stdout through the hook Claude Code actually runs',
  );
  assert.match(stdout, /412/);
});
