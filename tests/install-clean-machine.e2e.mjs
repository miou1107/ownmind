import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Does somebody who has installed nothing end up with a working install?
 *
 * Before this file: 356 test files, 26 of them naming `install.sh`, and not one that ran it.
 * Every piece was covered - the hook writers, the path helpers, the MCP registration helper -
 * and the thing a user actually executes was not. That is how a machine can report "the tool
 * is not registered in the file Claude Code reads" while the suite stays green, which is
 * exactly what one of the Windows machines had been reporting.
 *
 * So this runs the real installer into a throwaway home and then asks each feature whether it
 * works, rather than whether it was written down somewhere:
 *
 *   - registered is not the same as starts, so the MCP server is spawned and asked for its
 *     tools the way Claude Code would
 *   - a registered hook is not the same as a hook that blocks, so a guarded edit is pushed
 *     through the command that is actually in settings.json
 *   - an installed git hook is not the same as one that stops a commit, so a key-shaped
 *     string is staged in a real repository and the hook is run
 *
 * ## Two things this deliberately does not exercise
 *
 * **The GitHub clone.** `install.sh` clones from github.com; this seeds ~/.ownmind from the
 * commit under test instead, by way of a bare repo that stands in as the remote. Otherwise
 * the run would install origin/main and tell you nothing about the branch, and a red result
 * would mean "GitHub was slow" as often as anything else. The installer's *other* branch -
 * `git pull` into an existing ~/.ownmind - is exercised, and the bare repo is what makes that
 * possible: `actions/checkout@v4` leaves a `pull_request` build on a detached HEAD with no
 * local branch, a clone of that is detached too, and `git pull` there exits 1 with "you are
 * not currently on a branch". Cloning the checkout directly would therefore have been green
 * on every push and red on every pull request.
 *
 * Note that this installs *committed* state. Uncommitted work in the tree is not covered.
 *
 * **The scheduler.** `$HOME/.ownmind/.no-usage-scanner` is set on purpose. Without it the
 * installer calls `launchctl load -w` / `systemctl --user enable --now`, which register with
 * the live login session and not with $HOME - a test has no business doing that to the
 * machine running it. The scheduler has its own tests; this file must not be the reason a
 * developer finds an agent they did not install.
 *
 * Not in the `node --test` default glob (`tests/` is not `test/`, and the extension is not
 * `.test.js`) because it does an `npm install` and takes minutes. The `install` job in
 * .github/workflows/test.yml runs it by name, and `install-e2e-is-actually-run.test.js`
 * fails if that stops being true - a slow test quietly dropped from CI is worse than no test.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);

const API_KEY = 'clean-machine-test-key-0123456789';

/** Everything `before` produces, so each test reads state rather than rebuilding it. */
const world = {
  home: '',
  installOut: '',
  installStatus: null,
  stub: null,
  apiUrl: '',
};

/** A server the installer's beacons can reach, so a dead URL never becomes the story. */
async function startStub() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/api/memory/init')) {
        res.end(JSON.stringify({ profile: null, iron_rules: [], memories: [] }));
      } else {
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

/**
 * The environment that keeps every child inside the throwaway home.
 *
 * `HOME` and `USERPROFILE` alone are not a seal. `install.sh` runs `git config --global`,
 * and when `XDG_CONFIG_HOME` is set and the throwaway `$HOME/.gitconfig` does not exist yet,
 * git writes to `$XDG_CONFIG_HOME/git/config` - the developer's real one. This file then
 * deletes the directory that config points at, leaving `core.hooksPath` aimed at nothing and
 * git hooks silently off in every repository on that machine. `GIT_CONFIG_GLOBAL` names the
 * file outright, which no lookup order can reroute; `XDG_CONFIG_HOME` covers everything else
 * that follows the same convention.
 *
 * Every spawn in this file uses this - including the MCP preflight, whose child would
 * otherwise inherit the real `HOME` from `process.env` and run its auto-update against the
 * developer's own ~/.ownmind.
 */
function sandboxEnv(extra = {}) {
  return {
    ...process.env,
    HOME: world.home,
    USERPROFILE: world.home,
    XDG_CONFIG_HOME: path.join(world.home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(world.home, '.gitconfig'),
    ...extra,
  };
}

before(async () => {
  world.stub = await startStub();
  world.apiUrl = `http://127.0.0.1:${world.stub.address().port}`;

  // Not tests/helpers/temp-dir.js: that registers an `after` hook to remove the directory,
  // and this one holds a git checkout plus a node_modules tree that must survive every test
  // in the file. It is removed by this file's own `after` below.
  world.home = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-clean-install-'));

  // A bare repo standing in for github.com, carrying the commit under test on a real branch.
  // Pushing writes only to the bare repo, so the checkout being tested is never touched -
  // and the clone below lands on a branch with an upstream, which is what lets the
  // installer's `git pull` succeed from a detached-HEAD build. See the note in the docblock.
  const origin = path.join(world.home, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['-C', repoRoot, 'push', '-q', origin, 'HEAD:refs/heads/main']);
  execFileSync('git', [
    'clone', '-q', '--no-hardlinks', '--branch', 'main', origin, path.join(world.home, '.ownmind'),
  ]);
  fs.writeFileSync(path.join(world.home, '.ownmind', '.no-usage-scanner'), '');

  const r = spawnSync('bash', [path.join(repoRoot, 'install.sh'), API_KEY, world.apiUrl], {
    env: sandboxEnv(),
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
  });
  world.installStatus = r.status;
  world.installOut = `${r.stdout || ''}${r.stderr || ''}`;
});

after(() => {
  world.stub?.close();
  if (world.home) fs.rmSync(world.home, { recursive: true, force: true });
});

const inHome = (...parts) => path.join(world.home, ...parts);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/** Every hook command registered under `event`, whatever its matcher. */
function hookCommands(settings, event) {
  return (settings.hooks?.[event] || []).flatMap((entry) => (entry.hooks || []).map((h) => h.command));
}

/**
 * The script out of a registered hook command, whichever form the installer wrote.
 *
 * Two shapes reach this: `bash ~/.claude/hooks/x.sh` and `node "/abs/path/x.js"`. Stripping
 * a leading and trailing quote independently would leave the opening quote on the second
 * form and produce an unopenable path, so the argument is unquoted as a whole.
 */
function hookScriptPath(command) {
  const arg = command.slice(command.indexOf(' ') + 1).trim();
  const unquoted = arg.startsWith('"') && arg.endsWith('"') ? arg.slice(1, -1) : arg;
  return unquoted.startsWith('~') ? path.join(world.home, unquoted.slice(1)) : unquoted;
}

test('the installer finishes, and says so', () => {
  assert.equal(
    world.installStatus, 0,
    `install.sh exited ${world.installStatus}. Output:\n${world.installOut.slice(-4000)}`,
  );
  assert.match(world.installOut, /OwnMind installation complete/);
  // `set -eE` plus the ERR trap: an abort prints this and keeps going to the summary, so a
  // zero exit is not on its own proof that every step ran.
  assert.doesNotMatch(world.installOut, /\[FAIL\] install\.sh aborted/);
});

test('the tool is registered in the file Claude Code actually reads', () => {
  // ~/.claude.json, not ~/.claude/settings.json. A machine reported "no mcpServers.ownmind in
  // ~/.claude.json" while everything else looked healthy, and no test could see the
  // difference because none of them looked at a real installed home.
  const claudeJson = readJson(inHome('.claude.json'));
  const entry = claudeJson.mcpServers?.ownmind;
  assert.ok(entry, `~/.claude.json has no mcpServers.ownmind. Keys: ${Object.keys(claudeJson.mcpServers || {})}`);
  assert.ok(entry.command, 'the entry has no command to launch');
});

test('the registered tool actually starts and answers', async () => {
  // Registered and starts are separated by a lot of machinery, and this repository has shipped
  // four separate registrations that read perfectly and did not launch. Reading the entry
  // proves the first; only spawning it proves the second.
  const { preflightMcp, readRegistration } = require_(
    path.join(repoRoot, 'scripts/install-helpers/mcp-preflight.cjs'),
  );

  // The entry is passed in with a sandboxed env rather than left to `preflightMcp` to read.
  // Its `home` option governs which file the entry is read from and nothing else: the child
  // is spawned with `{...process.env, ...entry.env}`, so HOME would arrive from the developer's
  // own shell and the server would resolve - and auto-update - the real ~/.ownmind.
  const registration = readRegistration({ home: world.home });
  assert.ok(!registration.error, `could not read the registration: ${registration.error}`);
  const entry = { ...registration.entry, env: { ...(registration.entry.env || {}), ...sandboxEnv() } };

  const result = await preflightMcp({ home: world.home, entry, timeoutMs: 60_000 });
  assert.equal(
    result.status, 'ok',
    `the MCP server did not answer: ${result.reason} (phase: ${result.phase})`,
  );
  assert.ok(result.ownmind_tool_count > 0, 'the server started but offers no ownmind_* tools');
});

test('every hook a session depends on is registered', () => {
  const settings = readJson(inHome('.claude', 'settings.json'));
  for (const event of ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit']) {
    assert.ok(hookCommands(settings, event).length > 0, `no ${event} hook was registered`);
  }
  // Both matchers: commands and file edits reach the gate through different entries, and an
  // install that wired only one leaves half the rules unenforced while looking configured.
  const matchers = (settings.hooks.PreToolUse || []).map((e) => e.matcher);
  assert.ok(matchers.includes('Bash'), `no PreToolUse entry for Bash; matchers: ${matchers}`);
  assert.ok(
    matchers.some((m) => typeof m === 'string' && m.includes('Edit')),
    `no PreToolUse entry for the edit tools; matchers: ${matchers}`,
  );
});

test('the files the hooks reach for by absolute path are all there', () => {
  // The hooks resolve these under $HOME rather than relative to themselves. A missing one
  // does not crash loudly - it makes the hook fail open, which reads as a quiet day.
  for (const rel of [
    ['.claude', 'hooks', 'ownmind-iron-rule-check.sh'],
    ['.claude', 'hooks', 'ownmind-session-start.sh'],
    ['.ownmind', 'hooks', 'ownmind-edit-reminder.js'],
    ['.ownmind', 'hooks', 'lib', 'path-guard.js'],
    ['.ownmind', 'shared', 'helpers.js'],
    ['.ownmind', 'mcp', 'index.js'],
    ['.ownmind', 'package.json'],
  ]) {
    assert.ok(fs.existsSync(inHome(...rel)), `missing after install: ~/${path.join(...rel)}`);
  }
});

test('the registered edit hook really blocks an edit to somebody else\'s path', () => {
  // Driven through the command string that is in settings.json, not through the module. The
  // guard has been written into the wrong file before: it passed its unit tests and ran on no
  // machine, because what Claude Code executes is the .sh and the .sh called something else.
  const settings = readJson(inHome('.claude', 'settings.json'));
  const command = (settings.hooks.PreToolUse || [])
    .find((e) => typeof e.matcher === 'string' && e.matcher.includes('Edit'))
    ?.hooks?.[0]?.command;
  assert.ok(command, 'no edit-tool hook command to run');

  const repo = path.join(world.home, 'guarded-monorepo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://example.com/guarded-monorepo.git']);

  fs.writeFileSync(
    inHome('.ownmind', 'cache', 'enforcement.json'),
    JSON.stringify({
      selectors: [],
      guards: [{
        id: 412,
        type: 'team_standard',
        title: 'ci ownership belongs to the colleague',
        repo_match: 'guarded-monorepo',
        paths: ['ci/**'],
        owner: 'Colleague',
      }],
      injectables: [],
    }),
  );

  const fire = (filePath) => {
    const payload = JSON.stringify({
      tool_name: 'Edit',
      session_id: 'clean-install-e2e',
      tool_input: { file_path: filePath },
    });
    const r = spawnSync('bash', [hookScriptPath(command)], {
      input: payload, env: sandboxEnv(), encoding: 'utf8', timeout: 60_000,
    });
    return { out: `${r.stdout || ''}`, err: `${r.stderr || ''}` };
  };

  // Deliberately a file in a folder that does not exist yet: adding the first file under a
  // guarded path is the ordinary shape of this, and it was the shape that walked through.
  const blocked = fire(path.join(repo, 'ci', 'templates', 'projects.yml'));
  assert.match(
    blocked.out, /"decision"\s*:\s*"block"/,
    `the installed hook did not block. stdout: ${blocked.out}\nstderr: ${blocked.err}`,
  );
  // The reason line itself, not just the number appearing somewhere in the payload.
  const reason = JSON.parse(blocked.out).reason;
  assert.match(reason, /Blocked by team standard 412/);
  assert.match(reason, /ci\/templates\/projects\.yml/);

  // The negative, without which a hook that blocked everything would pass the assertion above.
  const allowed = fire(path.join(repo, 'src', 'mine', 'index.js'));
  assert.doesNotMatch(
    allowed.out, /"decision"\s*:\s*"block"/,
    `the installed hook blocked a path nobody claimed: ${allowed.out}`,
  );
});

test('the installed git hook really stops a commit carrying a key', () => {
  const hooksPath = execFileSync('git', ['config', '--global', 'core.hooksPath'], {
    env: sandboxEnv(), encoding: 'utf8',
  }).trim();
  assert.ok(
    hooksPath.startsWith(world.home),
    `core.hooksPath points outside the throwaway home: ${hooksPath}`,
  );
  assert.ok(hooksPath, 'no global core.hooksPath was set, so the git hooks run for nobody');
  const preCommit = path.join(hooksPath, 'pre-commit');
  assert.ok(fs.existsSync(preCommit), `no pre-commit hook at ${preCommit}`);

  const repo = path.join(world.home, 'secret-repo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  // AWS's own published example value, assembled at runtime rather than written out.
  // Nothing here is a live credential, but the hook under test cannot know that - it
  // blocked this very file from being committed when the value was a literal, which is
  // the behaviour the test exists to confirm.
  const fakeKey = `AKIA${'IOSFODNN7'}${'EXAMPLE'}`;
  fs.writeFileSync(path.join(repo, 'conf.env'), `AWS_ACCESS_KEY_ID=${fakeKey}\n`);
  execFileSync('git', ['-C', repo, 'add', 'conf.env']);

  const r = spawnSync('bash', [preCommit], {
    cwd: repo, env: sandboxEnv(), encoding: 'utf8', timeout: 60_000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  assert.equal(
    r.status, 1,
    `the pre-commit hook let a key through (exit ${r.status}).\n${out}`,
  );
  // Why it stopped, not only that it stopped. A rule set to "do not block" prints
  // `all N rules passed ✓` over a leaked key - a green tick and a zero exit are both
  // survivable on their own, and the pair of them is what makes that defect invisible.
  assert.match(out, /blocked|敏感|secret|key/i, `the hook exited 1 without saying why:\n${out}`);
  assert.doesNotMatch(out, /rules passed/, 'the hook reported a pass while stopping the commit');
});

test('the rules block lands in the CLAUDE.md the assistant reads', () => {
  const claudeMd = inHome('.claude', 'CLAUDE.md');
  assert.ok(fs.existsSync(claudeMd), 'no ~/.claude/CLAUDE.md was written');
  const text = fs.readFileSync(claudeMd, 'utf8');
  assert.match(text, /<!-- ownmind-rules -->/, 'the OwnMind block is not in CLAUDE.md');
});

test('the opt-out kept the installer from touching the machine\'s scheduler', () => {
  // The one outcome that must be impossible: this file must never be the reason a developer
  // finds a launch agent they did not install. The plist path is the assertion rather than
  // `launchctl list`, because a developer's own OwnMind install is expected to be listed
  // there and is none of this test's business.
  //
  // It is also the check on the opt-out itself. If `.no-usage-scanner` ever stops being
  // honoured, it shows up here rather than on somebody's machine three weeks later.
  assert.equal(
    fs.existsSync(path.join(world.home, 'Library', 'LaunchAgents')), false,
    'the installer wrote a launch agent despite the .no-usage-scanner opt-out',
  );
  assert.equal(
    fs.existsSync(path.join(world.home, '.config', 'systemd', 'user', 'ownmind-usage-scanner.timer')),
    false,
    'the installer wrote a systemd timer despite the .no-usage-scanner opt-out',
  );
  assert.match(world.installOut, /Skipping usage scanner install|Windows: register usage scanner/);
});
