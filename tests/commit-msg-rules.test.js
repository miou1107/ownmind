/**
 * v1.26.104 — commit-message rules are evaluated against the message being committed
 *
 * Git runs hooks in this order:
 *
 *   pre-commit → prepare-commit-msg → editor → commit-msg
 *
 * `.git/COMMIT_EDITMSG` is not written with the current message until after pre-commit
 * has run. So a pre-commit hook that reads that file is reading the PREVIOUS commit's
 * message — measured directly: with two commits in a row, pre-commit saw "FIRST MESSAGE"
 * while commit-msg saw "SECOND MESSAGE".
 *
 * Observed 2026-08-09. A commit was rejected by the commit-msg hook for a `Co-Authored-By`
 * trailer, the trailer was removed, and the retry was rejected again — this time by
 * pre-commit, quoting a trailer the message no longer contained.
 *
 * Both directions are wrong, and the second one is the one that matters:
 *   1. False block — fix the violation, get blocked again on the old message.
 *   2. False pass — attempt 1 clean, attempt 2 introduces a violation, pre-commit
 *      approves it against the stale text.
 *
 * The message therefore has to be judged in commit-msg, which receives its path as $1.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

const repoRoot = path.resolve(
  import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),
  '..'
);
const preCommitHook = path.join(repoRoot, 'hooks', 'ownmind-git-pre-commit.js');
const commitMsgHook = path.join(repoRoot, 'hooks', 'ownmind-git-commit-msg.js');

let tmpHome;
let tmpRepo;

const NO_TRAILER_RULE = {
  code: 'IR-024',
  title: 'Git commit 絕對不加 Co-Authored-By',
  tier: 'default',
  metadata: {
    verification: {
      mode: 'pre_action',
      trigger: ['commit'],
      conditions: {
        type: 'commit_message_not_contains',
        params: { patterns: ['Co-Authored-By'] },
        message: 'commit message 不能包含 Co-Authored-By',
      },
      block_on_fail: true,
    },
  },
};

// The other direction of the same mechanism. Nothing in production uses it today, which
// is exactly why it could stay broken unnoticed: the only two rules of this shape are
// also covered by a hardcoded grep in the shell hook.
const MUST_MENTION_TICKET_RULE = {
  code: 'IR-777',
  title: 'commit message must name a ticket',
  tier: 'default',
  metadata: {
    verification: {
      mode: 'pre_action',
      trigger: ['commit'],
      conditions: {
        type: 'commit_message_contains',
        params: { patterns: ['JIRA-'] },
        message: 'commit message must reference a ticket',
      },
      block_on_fail: true,
    },
  },
};

function setupSandbox() {
  tmpHome = tempDir('ownmind-cm-home-');
  tmpRepo = tempDir('ownmind-cm-repo-');

  const cacheDir = path.join(tmpHome, '.ownmind', 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  writeRulesCache([NO_TRAILER_RULE]);

  const sharedDest = path.join(tmpHome, '.ownmind', 'shared');
  fs.mkdirSync(sharedDest, { recursive: true });
  for (const f of ['verification.js', 'iron-rule-tier.js', 'compliance.js', 'helpers.js']) {
    const src = path.join(repoRoot, 'shared', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(sharedDest, f));
  }

  runGit(['init', '-q']);
  runGit(['config', 'user.email', 'test@example.com']);
  runGit(['config', 'user.name', 'Test']);
  runGit(['config', 'commit.gpgsign', 'false']);
}

function cleanupSandbox() {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRepo, { recursive: true, force: true });
}

function writeRulesCache(rules) {
  fs.writeFileSync(
    path.join(tmpHome, '.ownmind', 'cache', 'iron_rules.json'),
    JSON.stringify(rules)
  );
}

function runGit(args, env = {}) {
  return spawnSync('git', args, {
    cwd: tmpRepo,
    encoding: 'utf8',
    env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, ...env },
  });
}

function stage(relPath, content) {
  const full = path.join(tmpRepo, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  runGit(['add', relPath]);
}

/** Put a message into .git/COMMIT_EDITMSG, which is what a previous attempt leaves behind. */
function seedStaleEditMsg(text) {
  fs.writeFileSync(path.join(tmpRepo, '.git', 'COMMIT_EDITMSG'), text);
}

function runPreCommit(env = {}) {
  return spawnSync('node', [preCommitHook], {
    cwd: tmpRepo,
    encoding: 'utf8',
    env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, ...env },
  });
}

function runCommitMsg(message, env = {}) {
  const msgPath = path.join(tmpRepo, '.git', 'COMMIT_EDITMSG');
  fs.writeFileSync(msgPath, message);
  return spawnSync('node', [commitMsgHook, msgPath], {
    cwd: tmpRepo,
    encoding: 'utf8',
    env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, ...env },
  });
}

// ============================================================
// The bug: pre-commit judged a message it cannot see
// ============================================================

describe('v1.26.104 — pre-commit does not judge the commit message', () => {
  beforeEach(setupSandbox);
  afterEach(cleanupSandbox);

  it('a violating message left over from a previous attempt does not block this one', () => {
    seedStaleEditMsg('previous try\n\nCo-Authored-By: Someone <x@y.z>\n');
    stage('src/index.js', 'console.log("clean");\n');
    const r = runPreCommit();
    assert.equal(r.status, 0,
      `pre-commit reads the PREVIOUS message and must not rule on it; stderr=${r.stderr}`);
  });

  it('its pass line does not count message rules it never evaluated', () => {
    seedStaleEditMsg('anything\n');
    stage('src/index.js', 'console.log("clean");\n');
    const r = runPreCommit();
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /1 rules? passed/,
      `the only cached rule is a message rule, which pre-commit cannot check — `
      + `claiming it passed is the same false assurance as checking it wrongly; stdout=${r.stdout}`);
  });
});

// ============================================================
// The fix: commit-msg judges the message it is handed
// ============================================================

describe('v1.26.104 — commit-msg evaluates message rules against $1', () => {
  beforeEach(setupSandbox);
  afterEach(cleanupSandbox);

  it('a message containing the forbidden trailer → exit 1', () => {
    const r = runCommitMsg('feat: thing\n\nCo-Authored-By: Someone <x@y.z>\n');
    assert.equal(r.status, 1, `should block; stderr=${r.stderr}`);
    assert.match(r.stderr, /IR-024/);
  });

  it('a clean message → exit 0', () => {
    const r = runCommitMsg('feat: thing\n');
    assert.equal(r.status, 0, `should pass; stderr=${r.stderr}`);
  });

  it('commit_message_contains is enforced too, not just the hardcoded trailer', () => {
    writeRulesCache([MUST_MENTION_TICKET_RULE]);
    const missing = runCommitMsg('feat: no ticket here\n');
    assert.equal(missing.status, 1,
      `the general mechanism must work, not only the one shape a grep covered; stderr=${missing.stderr}`);
    assert.match(missing.stderr, /IR-777/);

    const present = runCommitMsg('feat: JIRA-42 do the thing\n');
    assert.equal(present.status, 0, `stderr=${present.stderr}`);
  });

  it('OWNMIND_BYPASS skips the rule', () => {
    const r = runCommitMsg('feat: thing\n\nCo-Authored-By: Someone <x@y.z>\n',
      { OWNMIND_BYPASS: 'IR-024' });
    assert.equal(r.status, 0, `bypass should skip; stderr=${r.stderr}`);
  });

  it('an empty rule cache fails open', () => {
    writeRulesCache([]);
    const r = runCommitMsg('feat: thing\n\nCo-Authored-By: Someone <x@y.z>\n');
    assert.equal(r.status, 0, `no rules means nothing to enforce; stderr=${r.stderr}`);
  });

  it('a missing message path does not crash the commit', () => {
    const r = spawnSync('node', [commitMsgHook], {
      cwd: tmpRepo,
      encoding: 'utf8',
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
    });
    assert.equal(r.status, 0, `no argument must fail open, not abort a commit; stderr=${r.stderr}`);
  });
});

// ============================================================
// Reading the message out of the file git hands over
// ============================================================

describe('v1.26.104 — extractCommitMessage', () => {
  it('stops at the scissors line, so --verbose diffs are not part of the message', async () => {
    // Measured: `git commit --verbose` puts the staged diff below the scissors line and
    // does NOT comment it, so an added line reads as `+Co-Authored-By: …` — matched by a
    // substring rule, blocking a commit over text the message does not contain.
    const { extractCommitMessage } = await import(pathToFileURL(commitMsgHook).href);
    const raw = [
      'feat: totally clean',
      '# Please enter the commit message for your changes.',
      '# ------------------------ >8 ------------------------',
      'diff --git a/f.txt b/f.txt',
      '+Co-Authored-By: Someone <x@y.z>',
    ].join('\n');
    assert.equal(extractCommitMessage(raw), 'feat: totally clean');
  });

  it('strips git\'s template comments', async () => {
    const { extractCommitMessage } = await import(pathToFileURL(commitMsgHook).href);
    const raw = 'feat: thing\n# On branch main\n# Changes to be committed:\n';
    assert.equal(extractCommitMessage(raw), 'feat: thing');
  });

  it('keeps a message whose every line starts with the comment character', async () => {
    // `git commit -m '#123 fix'` cleans up with `whitespace`, so that line lands in the
    // real commit. Treating it as a comment would silently switch off every message rule
    // for anyone who writes issue numbers that way.
    const { extractCommitMessage } = await import(pathToFileURL(commitMsgHook).href);
    assert.equal(extractCommitMessage('#123 fix the thing\n'), '#123 fix the thing');
  });

  it('honours a custom core.commentChar', async () => {
    const { extractCommitMessage } = await import(pathToFileURL(commitMsgHook).href);
    const raw = 'feat: thing\n; a comment under commentChar=;\n';
    assert.equal(extractCommitMessage(raw, ';'), 'feat: thing');
    // And with the default char, that line is content rather than a comment.
    assert.equal(extractCommitMessage(raw), 'feat: thing\n; a comment under commentChar=;');
  });

  it('is not fooled by a scissors-looking line that is not one', async () => {
    const { extractCommitMessage } = await import(pathToFileURL(commitMsgHook).href);
    const raw = 'feat: document the >8 marker\nbody mentioning # ---- >8 ---- inline\n';
    assert.match(extractCommitMessage(raw), /body mentioning/);
  });
});

// ============================================================
// Through the shell wrapper, which is what git actually runs
// ============================================================
//
// tests/git-hook-co-authored-by.test.js drives this wrapper with the developer's real
// $HOME. On a machine where `~/.ownmind/hooks/ownmind-git-commit-msg.js` is not present
// — every CI checkout, and this repo before an install — those tests never reach the
// rule evaluation at all. They would keep passing if it were wired up wrongly.

describe('v1.26.104 — the shell wrapper reaches the rule check', () => {
  beforeEach(setupSandbox);
  afterEach(cleanupSandbox);

  const wrapper = path.join(repoRoot, 'hooks', 'ownmind-git-commit-msg');

  // ~/.ownmind is the git checkout in a real install, so the script's siblings — shared/
  // and hooks/lib/ — are simply there. Copying only the one file produced
  // ERR_MODULE_NOT_FOUND, which is a fair warning about what a partial mirror costs.
  function installClientInto(home) {
    const hooksDest = path.join(home, '.ownmind', 'hooks');
    fs.mkdirSync(hooksDest, { recursive: true });
    fs.copyFileSync(commitMsgHook, path.join(hooksDest, 'ownmind-git-commit-msg.js'));
    fs.cpSync(path.join(repoRoot, 'hooks', 'lib'), path.join(hooksDest, 'lib'), { recursive: true });
    fs.cpSync(path.join(repoRoot, 'shared'), path.join(home, '.ownmind', 'shared'), { recursive: true });
  }

  function runWrapper(message, env = {}) {
    const msgPath = path.join(tmpRepo, 'MSG');
    fs.writeFileSync(msgPath, message);
    return spawnSync('bash', [wrapper, msgPath], {
      cwd: tmpRepo,
      encoding: 'utf8',
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, ...env },
    });
  }

  it('a rule violation that is not the hardcoded trailer still blocks', () => {
    // The trailer guard cannot account for this one, so a pass here can only come from
    // the rule engine having been reached.
    installClientInto(tmpHome);
    writeRulesCache([MUST_MENTION_TICKET_RULE]);
    const r = runWrapper('feat: no ticket here\n');
    assert.equal(r.status, 1,
      `the wrapper must run the rule check, not just the grep; stderr=${r.stderr}`);
    assert.match(r.stderr, /IR-777/);
  });

  it('the trailer guard still fires on git\'s own lowercase spelling', () => {
    // `Co-authored-by:` is what git writes. A substring rule reading "Co-Authored-By"
    // does not match it, which is why the anchored case-insensitive guard stays.
    installClientInto(tmpHome);
    writeRulesCache([NO_TRAILER_RULE]);
    const r = runWrapper('feat: x\n\nCo-authored-by: Someone <x@y.z>\n');
    assert.equal(r.status, 1, `stderr=${r.stderr}`);
  });

  it('a client that has not installed the script yet can still commit', () => {
    // No installClientInto: ~/.ownmind/hooks is absent, as on a fresh checkout.
    writeRulesCache([MUST_MENTION_TICKET_RULE]);
    const r = runWrapper('feat: no ticket here\n');
    assert.equal(r.status, 0,
      `a missing script must fail open, not block every commit; stderr=${r.stderr}`);
  });

  it('a half-mirrored client fails open instead of aborting with a stack trace', () => {
    // The script is present but its siblings are not — the shape that broke the
    // SessionStart hook in v1.26.85. A static import cannot be caught: the module never
    // starts, node exits 1, and the wrapper cannot tell that from a rule violation.
    const hooksDest = path.join(tmpHome, '.ownmind', 'hooks');
    fs.mkdirSync(hooksDest, { recursive: true });
    fs.copyFileSync(commitMsgHook, path.join(hooksDest, 'ownmind-git-commit-msg.js'));
    fs.rmSync(path.join(tmpHome, '.ownmind', 'shared'), { recursive: true, force: true });
    writeRulesCache([MUST_MENTION_TICKET_RULE]);
    const r = runWrapper('feat: no ticket here\n');
    assert.equal(r.status, 0,
      `a partial install must not block the commit; stderr=${r.stderr}`);
    assert.doesNotMatch(r.stderr, /ERR_MODULE_NOT_FOUND/,
      `and must not print a stack trace at somebody trying to commit; stderr=${r.stderr}`);
  });

  it('runs from a directory that is not a git repository', () => {
    // `set -e` plus `VAR="$(git rev-parse …)"` terminates the script with git's status.
    // Without `|| true` this exits 128 silently, and git reports only that the hook
    // refused the commit.
    installClientInto(tmpHome);
    writeRulesCache([]);
    const outside = tempDir('ownmind-cm-nogit-');
    try {
      const msgPath = path.join(outside, 'MSG');
      fs.writeFileSync(msgPath, 'feat: clean\n');
      const r = spawnSync('bash', [wrapper, msgPath], {
        cwd: outside,
        encoding: 'utf8',
        env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
      });
      assert.equal(r.status, 0,
        `no git repo must not become exit 128; stderr=${r.stderr}`);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a message path containing spaces is handled', () => {
    installClientInto(tmpHome);
    writeRulesCache([MUST_MENTION_TICKET_RULE]);
    const msgPath = path.join(tmpRepo, 'my commit message.txt');
    fs.writeFileSync(msgPath, 'feat: no ticket here\n');
    const r = spawnSync('bash', [wrapper, msgPath], {
      cwd: tmpRepo,
      encoding: 'utf8',
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
    });
    assert.equal(r.status, 1, `stderr=${r.stderr}`);
    assert.match(r.stderr, /IR-777/);
  });
});

// ============================================================
// End to end, through real `git commit` with both hooks wired
// ============================================================

describe('v1.26.104 — fixing the message lets the retry through', () => {
  beforeEach(() => {
    setupSandbox();
    const hookDir = path.join(tmpRepo, '.githooks');
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(path.join(hookDir, 'pre-commit'),
      `#!/bin/sh\nexec node ${JSON.stringify(preCommitHook)}\n`);
    fs.writeFileSync(path.join(hookDir, 'commit-msg'),
      `#!/bin/sh\nexec node ${JSON.stringify(commitMsgHook)} "$1"\n`);
    fs.chmodSync(path.join(hookDir, 'pre-commit'), 0o755);
    fs.chmodSync(path.join(hookDir, 'commit-msg'), 0o755);
    runGit(['config', 'core.hooksPath', hookDir]);
  });
  afterEach(cleanupSandbox);

  it('attempt 1 blocked on the trailer, attempt 2 without it succeeds', () => {
    stage('src/index.js', 'console.log("clean");\n');

    const first = runGit(['commit', '-m', 'feat: thing\n\nCo-Authored-By: Someone <x@y.z>']);
    assert.equal(first.status, 1,
      `the trailer must block; stdout=${first.stdout} stderr=${first.stderr}`);

    const second = runGit(['commit', '-m', 'feat: thing']);
    assert.equal(second.status, 0,
      `removing the trailer must be enough — this is the reported failure; `
      + `stdout=${second.stdout} stderr=${second.stderr}`);
  });

  // The mirror case, and the reason this is not merely an annoyance: a clean first
  // attempt would leave a clean COMMIT_EDITMSG behind, so a stale-reading check would
  // wave the second one through.
  it('a clean attempt followed by a violating one still blocks', () => {
    stage('src/index.js', 'console.log("clean");\n');
    const first = runGit(['commit', '-m', 'feat: clean']);
    assert.equal(first.status, 0, `stdout=${first.stdout} stderr=${first.stderr}`);

    stage('src/other.js', 'console.log("more");\n');
    const second = runGit(['commit', '-m', 'feat: more\n\nCo-Authored-By: Someone <x@y.z>']);
    assert.equal(second.status, 1,
      `a violation introduced after a clean attempt must still be caught; `
      + `stdout=${second.stdout} stderr=${second.stderr}`);
  });
});
