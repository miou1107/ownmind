/**
 * v1.19.7 — git pre-commit hook 整合 secret-detect 測試
 *
 * 對應 openspec/changes/v1.20-iron-rule-enforcement/spec.md：
 *   - 場景 1：IR-002 偵測 .env 檔案進 staged → 擋
 *   - 場景 2：IR-002 偵測密碼樣式進 staged diff → 擋
 *   - 場景 18：OWNMIND_BYPASS=IR-002 → 跳過 + 寫 audit
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

  // 1. 假 cache
  const cacheDir = path.join(tmpHome, '.ownmind', 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, 'iron_rules.json'),
    JSON.stringify([IR_002_RULE])
  );

  // 2. 把 shared/*.js 跑得到的位置複製到 ~/.ownmind/shared
  // hook 透過 dynamic import 從這條路徑載入 verification.js
  //
  // v1.19.7 code-review I-6 註解：清單是手動維護、目前 verification.js 沒
  // 額外 import 其他 shared/、所以 4 個檔已足。維護條件：
  //   1) shared/verification.js 內若 `import` 了新的 shared/*.js → 此清單要補
  //   2) hook 透過 home/.ownmind/shared 動態載入的檔加入時 → 此清單要補
  // 失敗症狀：spawnSync 出來的 hook 抱怨「module not found」、測試紅。
  const sharedDest = path.join(tmpHome, '.ownmind', 'shared');
  fs.mkdirSync(sharedDest, { recursive: true });
  for (const f of ['verification.js', 'iron-rule-tier.js', 'compliance.js', 'helpers.js']) {
    const src = path.join(repoRoot, 'shared', f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(sharedDest, f));
    }
  }

  // 3. 初始化 git repo
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
  // hook 透過 process.cwd() 取得 staged diff、所以 spawn 時 cwd 設 tmpRepo
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
// 場景 1：.env 檔名擋
// ============================================================

describe('v1.19.7 pre-commit — 場景 1：.env 檔名擋', () => {
  beforeEach(setupSandbox);
  afterEach(cleanupSandbox);

  it('staged .env 進 commit → exit 1 + stderr 提到 IR-002', () => {
    stage('.env', 'NORMAL_VAR=ok\n');
    const r = runHook();
    assert.equal(r.status, 1, `該被擋、stderr=${r.stderr}`);
    assert.match(r.stderr, /IR-002/);
  });

  it('staged 正常檔 → exit 0', () => {
    stage('src/index.js', 'console.log("hi");');
    const r = runHook();
    assert.equal(r.status, 0, `該過、stderr=${r.stderr}`);
  });
});

// ============================================================
// 場景 2：staged diff 含密碼樣式擋（v1.19.7 新功能）
// ============================================================

describe('v1.19.7 pre-commit — 場景 2：staged diff 含密碼樣式擋', () => {
  beforeEach(setupSandbox);
  afterEach(cleanupSandbox);

  it('staged 檔內含 OpenAI key 樣式 → exit 1 + stderr 含 detected_by', () => {
    stage('src/config.js', 'const key = "sk-proj-abc123XYZdef456ghi789jkl";\n');
    const r = runHook();
    assert.equal(r.status, 1, `staged 內含 key 該被擋、stderr=${r.stderr}`);
    assert.match(r.stderr, /IR-002/);
    assert.match(r.stderr, /detected_by/);
    assert.match(r.stderr, /openai_api_key/);
  });

  it('staged 檔內含 GitHub PAT → exit 1', () => {
    stage('src/foo.js', 'const t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB";\n');
    const r = runHook();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /github_pat/);
  });

  it('staged 檔內含 JWT → exit 1', () => {
    stage(
      'src/jwt.js',
      'const j = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";'
    );
    const r = runHook();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /jwt/);
  });

  it('staged 檔含 "password" 變數名但無實際密鑰 → exit 0（skip_keyword=true）', () => {
    stage('src/auth.js', 'function checkPassword(input) { return input === "x"; }');
    const r = runHook();
    assert.equal(r.status, 0, `變數名含 password 不該被誤擋、stderr=${r.stderr}`);
  });

  it('staged 檔含一般長字串但非密鑰格式 → exit 0', () => {
    stage('src/long.js', 'const description = "這是一段普通的中文描述，內容沒有任何敏感資料";');
    const r = runHook();
    assert.equal(r.status, 0);
  });
});

// ============================================================
// 場景 18：OWNMIND_BYPASS=IR-002 跳過 + 寫 audit
// ============================================================

describe('v1.19.7 pre-commit — 場景 18：bypass 跳過 + 寫 audit', () => {
  beforeEach(setupSandbox);
  afterEach(cleanupSandbox);

  it('OWNMIND_BYPASS=IR-002 → 跳過、exit 0', () => {
    stage('.env', 'API_KEY=fake\n');
    const r = runHook({ OWNMIND_BYPASS: 'IR-002' });
    assert.equal(r.status, 0, `bypass 該跳過、stderr=${r.stderr}`);
  });

  it('OWNMIND_BYPASS=all → 跳過所有規則', () => {
    stage('.env', 'API_KEY=fake\n');
    stage('src/key.js', 'const k = "sk-proj-abc123XYZdef456ghi789jkl";');
    const r = runHook({ OWNMIND_BYPASS: 'all' });
    assert.equal(r.status, 0);
  });

  it('OWNMIND_BYPASS=IR-008 不影響 IR-002 → 仍會擋', () => {
    stage('.env', 'API_KEY=fake\n');
    const r = runHook({ OWNMIND_BYPASS: 'IR-008' });
    assert.equal(r.status, 1, '只 bypass IR-008、IR-002 仍該擋');
    assert.match(r.stderr, /IR-002/);
  });

  it('bypass 命中時寫 audit log（compliance jsonl）', () => {
    stage('.env', 'X=1\n');
    runHook({ OWNMIND_BYPASS: 'IR-002' });

    // 找今天的 compliance jsonl
    const today = new Date().toISOString().slice(0, 10);
    const logsDir = path.join(tmpHome, '.ownmind', 'logs');
    // appendCompliance 的實際路徑視 shared/compliance.js 而定，遍歷找含 bypass 字串
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
    assert.equal(foundBypass, true, 'bypass 該寫一筆 audit log');
  });
});

// ============================================================
// 邊界：no staged files / 規則 cache 空
// ============================================================

describe('v1.19.7 pre-commit — 邊界情境', () => {
  beforeEach(setupSandbox);
  afterEach(cleanupSandbox);

  it('no staged files → exit 0', () => {
    const r = runHook();
    assert.equal(r.status, 0);
  });

  it('規則 cache 空 + 無網路 → exit 0 fail-open', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.ownmind', 'cache', 'iron_rules.json'),
      '[]'
    );
    stage('.env', 'X=1\n');
    const r = runHook();
    // 規則空、跳過所有檢查、fail-open
    assert.equal(r.status, 0, `cache 空該 fail-open、stderr=${r.stderr}`);
  });
});
