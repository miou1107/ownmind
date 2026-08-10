/**
 * v1.26.124 — the secret scan no longer asks permission from the rule set.
 *
 * The reproduction, run on a real machine before the fix, in a scratch repository with the
 * account's actual iron rules (all three reminder-only, so the verifiable-rules cache held
 * `[]`):
 *
 *     $ printf 'AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/..."\napi_key = "sk-ant-api03-..."\n' > leak.txt
 *     $ git add leak.txt && git commit -m "test: add config"
 *     [master (root-commit) 68ea04b] test: add config
 *
 * It committed. No output, exit 0. The wrapper had run and this hook had run — verified
 * with a chained probe hook that printed — so nothing was misconfigured. The scan simply
 * sat inside the per-rule loop, behind `isSecretGuardRule`, below two exits that fire
 * whenever the user owns no machine-verifiable commit rule. That is the default state of a
 * new account, so the advertised "git commit hard-block" was inert for anyone who had not
 * hand-authored a verification block.
 *
 * These tests pin the property that made it possible: **a leak must be blocked on the paths
 * where no rule is doing the blocking.** Each case below is one of the exits that used to
 * pass silently, plus the reverse controls that keep the fix from degenerating into
 * "block everything".
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(
  import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),
  '..'
);
const hookPath = path.join(repoRoot, 'hooks', 'ownmind-git-pre-commit.js');

// The payload from the reproduction above. Both are documentation samples, not live
// credentials: the AWS string is the one in AWS's own signing examples, and the Anthropic
// one is structurally valid but all-A. Using the real reproduction rather than a minimal
// synthetic string is deliberate — a detector that only catches a tidy fixture is what let
// this through.
//
// Assembled at runtime, and not because of a style preference: writing the key as one
// literal made this very file un-committable. The first attempt to commit this release was
// blocked by the scan it adds, naming this fixture — the guard catching its own author is
// the loudest possible proof that it works, and splitting the prefix is how
// tests/pre-commit-secret.test.js has always handled the same problem. Do not "tidy" these
// back into single literals.
const LEAK = 'AWS_SECRET_ACCESS_KEY = "' + 'wJalrXUtnFEMI/' + 'K7MDENG/bPxRfiCYEXAMPLEKEY' + '"\n'
  + 'api_key = "' + 'sk-' + 'ant-api03-' + 'A'.repeat(40) + '"\n';

const CLEAN = 'export function add(a, b) {\n  return a + b;\n}\n';

/** A commit-time rule that is NOT a secret guard: exercises the "rules exist, none applies" exit. */
const NON_SECRET_COMMIT_RULE = {
  code: 'IR-900',
  title: '提交前必須改過測試',
  tier: 'default',
  metadata: {
    verification: {
      trigger: ['commit'],
      block_on_fail: true,
      conditions: {
        type: 'changed_source_requires_test',
        params: {},
        message: '改了程式卻沒改測試',
      },
    },
  },
};

/** The secret-guard rule proper — `staged_files_exclude` is what isSecretGuardRule keys on. */
const SECRET_GUARD_RULE = {
  code: 'IR-901',
  title: '不要 commit 金鑰',
  tier: 'default',
  metadata: {
    verification: {
      trigger: ['commit'],
      block_on_fail: true,
      conditions: {
        type: 'staged_files_exclude',
        params: { patterns: ['.env', '*.pem'] },
        message: 'staged 包含敏感檔案',
      },
    },
  },
};

let tmpHome;
let tmpRepo;

function runGit(args) {
  return spawnSync('git', args, { cwd: tmpRepo, encoding: 'utf8' });
}

function setCache(rules) {
  const cacheDir = path.join(tmpHome, '.ownmind', 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'iron_rules.json'), JSON.stringify(rules));
}

function stage(relPath, content) {
  const full = path.join(tmpRepo, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  runGit(['add', relPath]);
}

function runHook(env = {}) {
  return spawnSync('node', [hookPath], {
    cwd: tmpRepo,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      // No credentials in the sandbox home, so fetchAndCacheRules cannot reach a server.
      // That is the point: it puts the hook on the "cache empty and the fetch found
      // nothing" path, which is the most-travelled of the exits this release closes.
      ...env,
    },
  });
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-baseline-home-'));
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-baseline-repo-'));

  // The rule-driven path dynamic-imports these out of ~/.ownmind/shared. Copying them keeps
  // the secret-guard case below on the real code path rather than a degraded one.
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
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRepo, { recursive: true, force: true });
});

describe('a leak is blocked on every path that used to exit silently', () => {
  it('empty rule cache, unreachable server — the exact pre-fix reproduction', () => {
    setCache([]);
    stage('leak.txt', LEAK);
    const r = runHook();
    assert.equal(r.status, 1, `must block; got exit ${r.status}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
    assert.match(r.stderr, /BASELINE/, 'the block must name itself as the baseline, not a rule the user does not have');
  });

  it('no rule cache file at all — a machine that has never synced', () => {
    // Distinct from an empty array: readJsonSafe returns null here rather than [], and the
    // two took different branches before reaching the same silent exit.
    stage('leak.txt', LEAK);
    const r = runHook();
    assert.equal(r.status, 1, `must block; got exit ${r.status}\nstderr:${r.stderr}`);
  });

  it('rules exist but none is a secret guard — the second silent exit', () => {
    setCache([NON_SECRET_COMMIT_RULE]);
    stage('leak.txt', LEAK);
    const r = runHook();
    assert.equal(r.status, 1, `must block; got exit ${r.status}\nstderr:${r.stderr}`);
    assert.match(r.stderr, /BASELINE/);
  });

  it('names the file and how it was detected, so the user can find the line', () => {
    setCache([]);
    stage('config/prod.txt', LEAK);
    const r = runHook();
    assert.match(r.stderr, /config[\\/]prod\.txt/, 'the offending file must be named');
    assert.match(r.stderr, /detected_by=/, 'the user must be told what matched, not just that something did');
  });
});

describe('reverse controls — the fix must not become "block everything"', () => {
  it('clean source with an empty cache still commits', () => {
    // Without this, a baseline that blocked unconditionally would satisfy every test above.
    setCache([]);
    stage('ok.js', CLEAN);
    const r = runHook();
    assert.equal(r.status, 0, `clean content must pass; got exit ${r.status}\nstderr:${r.stderr}`);
  });

  it('nothing staged exits quietly', () => {
    setCache([]);
    const r = runHook();
    assert.equal(r.status, 0, `an empty stage is not a violation; got exit ${r.status}\nstderr:${r.stderr}`);
    assert.equal(r.stderr.trim(), '', 'and it must stay silent — this path is hit by every --amend');
  });

  it('a filename that merely looks alarming is not enough on its own', () => {
    // The scan reads added lines, not names. A file called credentials.md holding prose is
    // the false positive that would train the user to pass --no-verify by reflex.
    setCache([]);
    stage('credentials.md', '# How to rotate credentials\n\nAsk the admin for a new key.\n');
    const r = runHook();
    assert.equal(r.status, 0, `prose about credentials is not a credential; got exit ${r.status}\nstderr:${r.stderr}`);
  });
});

describe('the baseline stands down when a rule owns the finding', () => {
  it('a secret-guard rule blocks, and the leak is reported once, not twice', () => {
    setCache([SECRET_GUARD_RULE]);
    stage('leak.txt', LEAK);
    const r = runHook();
    assert.equal(r.status, 1, `must still block; got exit ${r.status}\nstderr:${r.stderr}`);
    const baselineMentions = (r.stderr.match(/BASELINE/g) || []).length;
    assert.equal(
      baselineMentions,
      0,
      'the user owns a rule for this; reporting it again as BASELINE would print the same leak twice',
    );
    assert.match(r.stderr, /IR-901/, 'their own rule is what should be named');
  });
});
