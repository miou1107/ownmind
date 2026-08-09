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

// ============================================================
// v1.26.103 — a pure rename carries no new content (bug-report id=10, 2026-08-05)
//
// `git mv`-ing a committed file re-scans it from scratch. `git diff --cached
// --name-status` correctly reports R100 with an identical blob SHA on both sides,
// but the content scan asks for the diff of ONE path — and a single-path diff has
// no deleted counterpart to pair with, so rename detection cannot run and every
// line comes back as an addition.
//
// Consequence: any committed file holding key-shaped text (a spec's positive
// example, a checksum table, a test fixture) becomes permanently un-moveable. The
// only way out is a bypass, which switches off every other rule at the same time.
// ============================================================

describe('v1.26.103 pre-commit — a pure rename carries no new content', () => {
  beforeEach(setupSandbox);
  afterEach(cleanupSandbox);

  // Split across concat so this repo's own pre-commit scanner does not read the
  // fixture as a live credential. Same synthetic material the wp-prose specs use.
  const WP_SHAPED = ['iXEN', 'ops5', 'pJcy', '8PJI', 'lVFM', 'heaH'].join(' ');

  function seedCommit(relPath, content) {
    stage(relPath, content);
    runGit(['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'seed']);
  }

  it('git mv of a committed file whose content is key-shaped → exit 0', () => {
    seedCommit('openspec/changes/wp-prose/spec.md',
      `positive example that must stay verbatim: ${WP_SHAPED}\n`);
    runGit(['mv', 'openspec/changes/wp-prose', 'openspec/changes/archive-wp-prose']);
    const r = runHook();
    assert.equal(r.status, 0,
      `a pure rename adds no content and must not be blocked; stderr=${r.stderr}`);
  });

  // The negative control. Without it the test above is satisfied by simply never
  // scanning a renamed file, which would open a hole: move a file and smuggle a
  // key in during the same commit.
  it('rename that also ADDS a secret line → still exit 1', () => {
    seedCommit('openspec/changes/wp-prose/spec.md',
      `positive example that must stay verbatim: ${WP_SHAPED}\n`);
    runGit(['mv', 'openspec/changes/wp-prose', 'openspec/changes/archive-wp-prose']);
    const moved = path.join(tmpRepo, 'openspec/changes/archive-wp-prose/spec.md');
    const fakeKey = 'sk-' + 'proj-' + 'abc123XYZdef456ghi789jkl';
    fs.appendFileSync(moved, `const key = "${fakeKey}";\n`);
    runGit(['add', '-A']);
    const r = runHook();
    assert.equal(r.status, 1,
      `content added during a rename must still be scanned; stderr=${r.stderr}`);
    assert.match(r.stderr, /openai_api_key/);
  });

  // Rename detection is a user-configurable git behaviour. If the fix relies on it
  // being on, it stops working for anyone who has turned it off — silently, in the
  // blocking direction.
  it('git mv with diff.renames=false in the repo config → still exit 0', () => {
    runGit(['config', 'diff.renames', 'false']);
    seedCommit('openspec/changes/wp-prose/spec.md',
      `positive example that must stay verbatim: ${WP_SHAPED}\n`);
    runGit(['mv', 'openspec/changes/wp-prose', 'openspec/changes/archive-wp-prose']);
    const r = runHook();
    assert.equal(r.status, 0,
      `the user's rename-detection setting must not decide this; stderr=${r.stderr}`);
  });

  // The source path comes from git, and git reads it back as a PATHSPEC — `--` does
  // not turn that off. A file committed as `:!victim.txt` is both a legal filename and
  // an exclude pattern, so pairing it with its destination cancels the destination out
  // of its own diff: git returns nothing and a secret added in the same commit is never
  // seen. This is the one way the fix could scan LESS than before it.
  // A colon is not a legal character in an NTFS filename — Windows reads it as the
  // alternate-data-stream separator — so `:!victim.txt` cannot be created there at all and
  // the two tests below report ENOENT rather than anything about the scanner. Stated as a
  // skip with its reason instead of a platform branch that silently drops them, and paired
  // with the `[ab].txt` cases further down, which cover the same defect class using a name
  // Windows does accept. Without those, skipping here would leave Windows with no coverage
  // of pathspec magic at all while still reporting a green run.
  const colonSkip = process.platform === 'win32'
    ? 'a colon cannot appear in an NTFS filename; the [ab].txt cases cover this on Windows'
    : false;

  it('rename whose source path is pathspec magic → the added secret is still caught', { skip: colonSkip }, () => {
    // Bulk matters: append one line to a one-line file and similarity drops under 50%,
    // git reports an unrelated delete plus add, no pairing is attempted and the test
    // passes without ever reaching the code it is meant to pin.
    seedCommit(':!victim.txt', 'nothing interesting here\n'.repeat(60));
    runGit(['mv', ':!victim.txt', 'victim.txt']);
    const fakeKey = 'sk-' + 'proj-' + 'abc123XYZdef456ghi789jkl';
    fs.appendFileSync(path.join(tmpRepo, 'victim.txt'), `const key = "${fakeKey}";\n`);
    runGit(['add', '-A']);
    const r = runHook();
    assert.equal(r.status, 1,
      `a path git hands back must be read literally, not as a pattern; stderr=${r.stderr}`);
    assert.match(r.stderr, /openai_api_key/);
  });

  // The same flaw in the harmless direction: an unmatched pathspec pairs nothing, so
  // the file reverts to being read whole and a plain move is blocked again.
  it('pure rename whose source path is pathspec magic → exit 0', { skip: colonSkip }, () => {
    seedCommit(':colon-start.txt',
      `positive example that must stay verbatim: ${WP_SHAPED}\n`);
    runGit(['mv', ':colon-start.txt', 'colon-start.txt']);
    const r = runHook();
    assert.equal(r.status, 0,
      `an unusual filename must not decide whether a move is blocked; stderr=${r.stderr}`);
  });

  // The same class with a name every platform accepts. `[ab]` is a character class to git's
  // pathspec globbing, so the literal filename does not match itself — verified directly:
  //
  //     git diff --cached --name-only HEAD -- '[ab].txt'   ->   "" (its own file, unmatched)
  //
  // Brackets are legal on NTFS, so unlike the colon cases these run on Windows, where the
  // rename-pairing code has otherwise never been exercised with a magic path.
  const GLOB_NAME = '[ab].txt';

  it('rename whose source path is glob magic → the added secret is still caught', () => {
    seedCommit(GLOB_NAME, 'nothing interesting here\n'.repeat(60));
    runGit(['mv', GLOB_NAME, 'globbed.txt']);
    const fakeKey = 'sk-' + 'proj-' + 'abc123XYZdef456ghi789jkl';
    fs.appendFileSync(path.join(tmpRepo, 'globbed.txt'), `const key = "${fakeKey}";\n`);
    runGit(['add', '-A']);
    const r = runHook();
    assert.equal(r.status, 1,
      `a path git hands back must be read literally, not as a pattern; stderr=${r.stderr}`);
    assert.match(r.stderr, /openai_api_key/);
  });

  it('pure rename whose source path is glob magic → exit 0', () => {
    seedCommit(GLOB_NAME, `positive example that must stay verbatim: ${WP_SHAPED}\n`);
    runGit(['mv', GLOB_NAME, 'globbed.txt']);
    const r = runHook();
    assert.equal(r.status, 0,
      `an unusual filename must not decide whether a move is blocked; stderr=${r.stderr}`);
  });

  // Every other test here stages exactly one file, so the parser only ever sees a
  // single record. This one gives it two of different shapes — a rename consumes three
  // NUL tokens, an add consumes two — and checks the attribution comes out right on
  // both: the added file's secret is reported, the moved file's untouched content is
  // not. (It does not pin the explicit non-rename advance itself; dropping that leaves
  // the loop to resynchronise on the next token that starts with ':'.)
  it('a rename staged alongside an unrelated add → both are read correctly', () => {
    seedCommit('openspec/changes/wp-prose/spec.md',
      `positive example that must stay verbatim: ${WP_SHAPED}\n`);
    runGit(['mv', 'openspec/changes/wp-prose', 'openspec/changes/archive-wp-prose']);
    const fakePat = 'ghp_' + 'abcdefghij' + 'klmnopqrst' + 'uvwxyz0123' + '456789AB';
    stage('src/newly-added.js', `const t = "${fakePat}";\n`);
    const r = runHook();
    assert.equal(r.status, 1,
      `the added file's secret must survive parsing alongside a rename; stderr=${r.stderr}`);
    assert.match(r.stderr, /github_pat/);
    assert.doesNotMatch(r.stderr, /wp_application_password/,
      `the moved file contributed no new content and must not be reported; stderr=${r.stderr}`);
  });

  // A rename is only exempt because the blob is byte-identical. Content edited in
  // the same commit changes the SHA, so the exemption must not apply.
  it('rename plus an edit to an existing line → scanned normally', () => {
    seedCommit('src/notes.md', 'nothing interesting here\n');
    runGit(['mv', 'src/notes.md', 'src/moved-notes.md']);
    const fakePat = 'ghp_' + 'abcdefghij' + 'klmnopqrst' + 'uvwxyz0123' + '456789AB';
    fs.writeFileSync(path.join(tmpRepo, 'src/moved-notes.md'), `token: ${fakePat}\n`);
    runGit(['add', '-A']);
    const r = runHook();
    assert.equal(r.status, 1,
      `an edited blob is new content whatever its path; stderr=${r.stderr}`);
    assert.match(r.stderr, /github_pat/);
  });
});

// ============================================================
// v1.26.33: the content scan must be de-identified — it must fire for the
// secret-guard rule based on its semantic identity (the commit_no_secrets
// template's conditions.type), NOT on the personal code IR-002. Otherwise a
// user whose secret rule has a different number gets no content scan and
// secrets slip through.
// ============================================================

const SECRET_RULE_NON_IR002 = {
  code: 'IR-099',
  title: "no secrets in commits (this user's numbering)",
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
        message: 'staged contains sensitive files',
      },
    },
  },
};

function writeRulesCache(rules) {
  fs.writeFileSync(
    path.join(tmpHome, '.ownmind', 'cache', 'iron_rules.json'),
    JSON.stringify(rules)
  );
}

describe('v1.26.33 pre-commit — secret content scan is code-agnostic', () => {
  beforeEach(() => { setupSandbox(); writeRulesCache([SECRET_RULE_NON_IR002]); });
  afterEach(cleanupSandbox);

  it('non-IR-002 secret-guard rule + secret in file content → still blocked', () => {
    // src/config.js does not match any filename-exclude pattern, so ONLY the
    // content scan can block it. Pre-fix that scan is gated on ruleCode==='IR-002',
    // so this IR-099 rule lets the secret through (the bug).
    const fakeKey = 'sk-' + 'proj-' + 'abc123XYZdef456ghi789jkl';
    stage('src/config.js', `const key = "${fakeKey}";\n`);
    const r = runHook();
    assert.equal(r.status, 1,
      `content secret must be blocked regardless of the rule's personal code; stderr=${r.stderr}`);
    assert.match(r.stderr, /detected_by|openai_api_key/,
      `block must originate from the content scan; stderr=${r.stderr}`);
  });
});
