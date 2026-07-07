/**
 * v1.19.7 — git pre-commit hook integration with secret-detect
 *
 * Tracks openspec/changes/v1.20-iron-rule-enforcement/spec.md:
 *   - Scenario 1: IR-002 detects .env in staged → block
 *   - Scenario 2: IR-002 detects password patterns in staged diff → block
 *   - Scenario 18: OWNMIND_BYPASS=IR-002 → skip + write audit
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

let tmpHome;
let tmpRepo;

const IR_002_RULE = {
  code: 'IR-002',
  title: '不要 commit .env 或密碼',
  tier: 'default',
  metadata: {
    verification: {
      trigger: ['commit'],
      block_on_fail: true,
      conditions: {
        type: 'staged_files_exclude',
        params: {
          patterns: ['.env', '*.pem', '**/*.pem', '*.key', '**/*.key', 'credentials.*'],
        },
        message: 'staged 包含敏感檔案',
      },
    },
  },
};

function setupSandbox() {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-pc-home-'));
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-pc-repo-'));

  // 1. Fake cache.
  const cacheDir = path.join(tmpHome, '.ownmind', 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, 'iron_rules.json'),
    JSON.stringify([IR_002_RULE])
  );

  // 2. Copy the shared/*.js files the hook needs to a runnable location under ~/.ownmind/shared.
  // The hook loads verification.js from this path via dynamic import.
  //
  // v1.19.7 code-review I-6 note: this list is hand-maintained. Today verification.js
  // does not import other shared/* files, so 4 files are enough. Maintenance rules:
  //   1) If shared/verification.js starts importing a new shared/*.js → add it here.
  //   2) If the hook starts dynamically loading another file from home/.ownmind/shared → add it here.
  // Failure symptom: spawnSync'd hook complains "module not found" and the test goes red.
  const sharedDest = path.join(tmpHome, '.ownmind', 'shared');
  fs.mkdirSync(sharedDest, { recursive: true });
  for (const f of ['verification.js', 'iron-rule-tier.js', 'compliance.js', 'helpers.js']) {
    const src = path.join(repoRoot, 'shared', f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(sharedDest, f));
    }
  }

  // 3. Initialize a git repo.
  runGit(['init', '-q']);
  runGit(['config', 'user.email', 'test@example.com']);
  runGit(['config', 'user.name', 'Test']);
  runGit(['config', 'commit.gpgsign', 'false']);
}

function cleanupSandbox() {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRepo, { recursive: true, force: true });
}

function runGit(args) {
  return spawnSync('git', args, { cwd: tmpRepo, encoding: 'utf8' });
}

function stage(relPath, content) {
  const full = path.join(tmpRepo, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  runGit(['add', relPath]);
}

function runHook(env = {}) {
  // The hook gets staged diff via process.cwd(), so spawn with cwd=tmpRepo.
  return spawnSync('node', [hookPath], {
    cwd: tmpRepo,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      GIT_COMMIT_MSG: 'test commit',
      ...env,
    },
  });
}

// ============================================================
// Scenario 1: .env filename blocked
// ============================================================

describe('v1.19.7 pre-commit — scenario 1: .env filename blocked', () => {
  beforeEach(setupSandbox);
  afterEach(cleanupSandbox);

  it('staged .env → exit 1 + stderr mentions IR-002', () => {
    stage('.env', 'NORMAL_VAR=ok\n');
    const r = runHook();
    assert.equal(r.status, 1, `should be blocked; stderr=${r.stderr}`);
    assert.match(r.stderr, /IR-002/);
  });

  it('staged normal file → exit 0', () => {
    stage('src/index.js', 'console.log("hi");');
    const r = runHook();
    assert.equal(r.status, 0, `should pass; stderr=${r.stderr}`);
  });
});

// ============================================================
// Scenario 2: staged diff contains password pattern → block (v1.19.7 new feature)
// ============================================================

describe('v1.19.7 pre-commit — scenario 2: staged diff contains password pattern → block', () => {
  beforeEach(setupSandbox);
  afterEach(cleanupSandbox);

  it('staged file contains an OpenAI key pattern → exit 1 + stderr contains detected_by', () => {
    // Fixture split across concat so the dev-machine pre-commit scanner won't catch it as a real secret.
    const fakeKey = 'sk-' + 'proj-' + 'abc123XYZdef456ghi789jkl';
    stage('src/config.js', `const key = "${fakeKey}";\n`);
    const r = runHook();
    assert.equal(r.status, 1, `staged content contains a key — should be blocked; stderr=${r.stderr}`);
    assert.match(r.stderr, /IR-002/);
    assert.match(r.stderr, /detected_by/);
    assert.match(r.stderr, /openai_api_key/);
  });

  it('staged file contains a GitHub PAT → exit 1', () => {
    const fakePat = 'ghp_' + 'abcdefghij' + 'klmnopqrst' + 'uvwxyz0123' + '456789AB';
    stage('src/foo.js', `const t = "${fakePat}";\n`);
    const r = runHook();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /github_pat/);
  });

  it('staged file contains a JWT → exit 1', () => {
    stage(
      'src/jwt.js',
      'const j = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";'
    );
    const r = runHook();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /jwt/);
  });

  it('staged file uses "password" as a variable name with no real secret → exit 0 (skip_keyword=true)', () => {
    stage('src/auth.js', 'function checkPassword(input) { return input === "x"; }');
    const r = runHook();
    assert.equal(r.status, 0, `variable name containing "password" must not be falsely blocked; stderr=${r.stderr}`);
  });

  it('staged file has a generic long string but not a secret format → exit 0', () => {
    stage('src/long.js', 'const description = "這是一段普通的中文描述，內容沒有任何敏感資料";');
    const r = runHook();
    assert.equal(r.status, 0);
  });
});

// ============================================================
// Scenario 18: OWNMIND_BYPASS=IR-002 → skip + write audit
// ============================================================

describe('v1.19.7 pre-commit — scenario 18: bypass skips + writes audit', () => {
  beforeEach(setupSandbox);
  afterEach(cleanupSandbox);

  it('OWNMIND_BYPASS=IR-002 → skip; exit 0', () => {
    stage('.env', 'API_KEY=fake\n');
    const r = runHook({ OWNMIND_BYPASS: 'IR-002' });
    assert.equal(r.status, 0, `bypass should skip; stderr=${r.stderr}`);
  });

  it('OWNMIND_BYPASS=all → skip every rule', () => {
    const fakeKey = 'sk-' + 'proj-' + 'abc123XYZdef456ghi789jkl';
    stage('.env', 'API_KEY=fake\n');
    stage('src/key.js', `const k = "${fakeKey}";`);
    const r = runHook({ OWNMIND_BYPASS: 'all' });
    assert.equal(r.status, 0);
  });

  it('OWNMIND_BYPASS=IR-008 does not affect IR-002 → still blocked', () => {
    stage('.env', 'API_KEY=fake\n');
    const r = runHook({ OWNMIND_BYPASS: 'IR-008' });
    assert.equal(r.status, 1, 'only IR-008 bypassed; IR-002 should still block');
    assert.match(r.stderr, /IR-002/);
  });

  it('on bypass hit, writes audit log (compliance jsonl)', () => {
    stage('.env', 'X=1\n');
    runHook({ OWNMIND_BYPASS: 'IR-002' });

    // Look for today's compliance jsonl.
    const today = new Date().toISOString().slice(0, 10);
    const logsDir = path.join(tmpHome, '.ownmind', 'logs');
    // appendCompliance's exact path depends on shared/compliance.js; scan for the bypass string.
    let foundBypass = false;
    if (fs.existsSync(logsDir)) {
      for (const f of fs.readdirSync(logsDir)) {
        const txt = fs.readFileSync(path.join(logsDir, f), 'utf8');
        if (txt.includes('"action":"bypass"') && txt.includes('IR-002')) {
          foundBypass = true;
          break;
        }
      }
    }
    assert.equal(foundBypass, true, 'bypass should write an audit log entry');
  });
});

// ============================================================
// Edge cases: no staged files / empty rule cache
// ============================================================

describe('v1.19.7 pre-commit — edge cases', () => {
  beforeEach(setupSandbox);
  afterEach(cleanupSandbox);

  it('no staged files → exit 0', () => {
    const r = runHook();
    assert.equal(r.status, 0);
  });

  it('empty rule cache + no network → exit 0 fail-open', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.ownmind', 'cache', 'iron_rules.json'),
      '[]'
    );
    stage('.env', 'X=1\n');
    const r = runHook();
    // No rules — skip every check; fail-open.
    assert.equal(r.status, 0, `empty cache should fail-open; stderr=${r.stderr}`);
  });

  // Regression: `git rm --cached file.pem` stages a deletion. The repo is
  // *removing* the sensitive file from index — the desired cleanup action —
  // and must not be blocked by IR-002's staged_files_exclude filename match.
  it('staged deletion of sensitive file (git rm --cached) → exit 0', () => {
    // First commit the .pem so we have something to delete.
    stage('secrets/key.pem', 'PRIVATE\n');
    runGit(['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'seed']);
    // Now stage its deletion from index.
    runGit(['rm', '--cached', 'secrets/key.pem']);
    const r = runHook();
    assert.equal(r.status, 0, `deletion of .pem must pass; stderr=${r.stderr}`);
  });
});

// ============================================================
// v1.26.28 — separator-line false positive + actionable block message
// (bug-report id=6, 2026-07-07)
// ============================================================

describe('v1.26.28 pre-commit — separator lines pass, block message shows matched text', () => {
  beforeEach(setupSandbox);
  afterEach(cleanupSandbox);

  it('staged analysis file with dash separator lines → exit 0', () => {
    // Reproduces the funpass block: report .md files with horizontal rules.
    const content = [
      '# DataForSEO pull',
      '-'.repeat(66),
      'env-var references only, no hardcoded values:',
      `auth = base64.b64encode(f"{env['DF_LOGIN']}:{env['DF_PASSWORD']}".encode()).decode()`,
      '-'.repeat(66),
    ].join('\n');
    stage('analysis/86_report.md', content);
    const r = runHook();
    assert.equal(r.status, 0,
      `separator lines must not block; stderr=${r.stderr}`);
  });

  it('regex hit (known real-key format) → block message shows a MASKED fragment', () => {
    // A regex:* hit is very likely a real secret. Echoing it in full would
    // land the key in the terminal + session transcript, right next to the
    // "call ownmind_report_bug" call-to-action — a path to the cloud.
    // head(8) + '…' + tail(4) is still enough to grep for the line.
    const fakeKey = 'sk-' + 'proj-' + 'abc123XYZdef456ghi789jkl';
    stage('src/config.js', `const key = "${fakeKey}";\n`);
    const r = runHook();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /matched="sk-proj-…9jkl"/,
      `block message must include the masked fragment; stderr=${r.stderr}`);
    assert.doesNotMatch(r.stderr, /abc123XYZdef456ghi789jkl/,
      `full key must never be echoed; stderr=${r.stderr}`);
  });

  it('heuristic hit (probably a false positive) → block message shows the FULL fragment', () => {
    // heuristic:long_alnum hits are exactly the ones users need to locate
    // (bug-report id=6 was misdiagnosed for lack of this), and by definition
    // they are only "key-shaped", not a known secret format.
    const token = 'a1B2c3D4e5F6g7H8i9J0kL';
    stage('data/checksums.txt', token + '\n');
    const r = runHook();
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`matched="${token}"`),
      `heuristic fragment must be shown in full; stderr=${r.stderr}`);
  });
});
