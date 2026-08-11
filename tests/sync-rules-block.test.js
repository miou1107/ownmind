import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(repoRoot, 'scripts/install-helpers/sync-rules-block.cjs');

/**
 * v1.26.141 — the rules block has to be updatable on a machine that already has one.
 *
 * `install.sh` used to append this content with a heredoc and then skip the file forever
 * after, on the strength of the word "OwnMind" appearing anywhere in it. Every machine's
 * copy froze on its install date: measured 2026-08-11, one was still carrying a four-line
 * block that had been superseded three times, and `update.sh` / `update.ps1` never touched
 * the file at all.
 *
 * The file this writes into is where people keep their own rules. Two things therefore
 * matter more than the update itself: never lose what they wrote, and never leave the file
 * truncated if the write is interrupted.
 */

function run(args, { expectFail = false } = {}) {
  try {
    const out = execFileSync('node', [script, ...args], { encoding: 'utf8' });
    assert.ok(!expectFail, `expected a failure, got: ${out}`);
    return out.trim();
  } catch (err) {
    assert.ok(expectFail, `unexpected failure: ${err.stderr || err.message}`);
    return String(err.stderr || '').trim();
  }
}

function fixture(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-block-'));
  const target = path.join(dir, 'CLAUDE.md');
  const snippet = path.join(dir, 'block.md');
  fs.writeFileSync(snippet, '## OwnMind rules\n\nrule one\n');
  if (contents !== null) fs.writeFileSync(target, contents);
  return { dir, target, snippet };
}

const read = (p) => fs.readFileSync(p, 'utf8');
const count = (s, re) => (s.match(re) || []).length;

describe('sync-rules-block — writing the block', () => {
  it('creates the file when the directory exists and the file does not', () => {
    const { target, snippet } = fixture(null);
    assert.match(run(['--target', target, '--marker', 'ownmind-rules', '--snippet', snippet]), /^written:/);
    assert.match(read(target), /<!-- ownmind-rules -->[\s\S]*rule one[\s\S]*<!-- \/ownmind-rules -->/);
  });

  it('reports skipped when the tool is not installed', () => {
    const { dir, snippet } = fixture(null);
    const target = path.join(dir, 'not-installed', 'CLAUDE.md');
    assert.match(run(['--target', target, '--marker', 'ownmind-rules', '--snippet', snippet]), /^skipped:/);
    assert.equal(fs.existsSync(target), false);
  });

  it('an existing empty file is content, not an error', () => {
    const { target, snippet } = fixture('');
    assert.match(run(['--target', target, '--marker', 'ownmind-rules', '--snippet', snippet]), /^written:/);
    assert.match(read(target), /rule one/);
  });

  it("keeps the user's own content", () => {
    const { target, snippet } = fixture('# My rules\n\nnever force push\n');
    run(['--target', target, '--marker', 'ownmind-rules', '--snippet', snippet]);
    assert.match(read(target), /never force push/);
  });

  /** IR: an operation that runs on every update has to be safe to run twice. */
  it('running twice leaves exactly one block, carrying the newer text', () => {
    const { target, snippet } = fixture('# My rules\n\nkeep me\n');
    run(['--target', target, '--marker', 'ownmind-rules', '--snippet', snippet]);
    fs.writeFileSync(snippet, '## OwnMind rules\n\nrule two\n');
    run(['--target', target, '--marker', 'ownmind-rules', '--snippet', snippet]);
    const body = read(target);
    assert.equal(count(body, /<!-- ownmind-rules -->/g), 1);
    assert.match(body, /rule two/);
    assert.doesNotMatch(body, /rule one/);
    assert.match(body, /keep me/);
  });

  it('leaves a different marker alone — two managed blocks coexist', () => {
    const { target, snippet } = fixture('# Mine\n\n<!-- ownmind-upgrade-rule -->\nupgrade text\n<!-- /ownmind-upgrade-rule -->\n');
    run(['--target', target, '--marker', 'ownmind-rules', '--snippet', snippet]);
    const body = read(target);
    assert.match(body, /upgrade text/);
    assert.match(body, /rule one/);
  });

  it('does not accumulate blank lines across runs', () => {
    const { target, snippet } = fixture('# Mine\n\nkeep me\n');
    for (let i = 0; i < 4; i += 1) run(['--target', target, '--marker', 'ownmind-rules', '--snippet', snippet]);
    assert.doesNotMatch(read(target), /\n{4,}/, 'four runs should not leave a growing gap');
  });

  it('writes UTF-8 without a BOM, and round-trips non-ASCII the user wrote', () => {
    const { target, snippet } = fixture('# 我的規則\n\n先問再改\n');
    run(['--target', target, '--marker', 'ownmind-rules', '--snippet', snippet]);
    const raw = fs.readFileSync(target);
    assert.notDeepEqual([raw[0], raw[1], raw[2]], [0xef, 0xbb, 0xbf]);
    assert.match(raw.toString('utf8'), /先問再改/);
  });

  it('reports an error rather than a success when the snippet is missing', () => {
    const { target } = fixture('# Mine\n');
    const err = run(['--target', target, '--marker', 'ownmind-rules', '--snippet', '/no/such/file'], { expectFail: true });
    assert.match(err, /^error:/);
  });

  it('leaves no temp file behind', () => {
    const { dir, target, snippet } = fixture('# Mine\n');
    run(['--target', target, '--marker', 'ownmind-rules', '--snippet', snippet]);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), []);
  });
});

/**
 * The migration. Machines installed before this version carry an unmarked block that the
 * updater cannot recognise, so without this the next upgrade would add a second copy of the
 * same rules and leave the stale one above it.
 *
 * It is only safe to remove because the match is exact: every line has to be one this
 * project has shipped. A block someone edited is theirs, and gets left where it is.
 */
describe('sync-rules-block — the unmarked block older installs left behind', () => {
  const LEGACY = [
    '# OwnMind 個人記憶系統',
    '',
    'OwnMind 記憶透過 SessionStart hook 自動載入（不需手動呼叫 ownmind_init）。',
    '如果 context 中沒有看到【OwnMind vX.X.X】標記，手動呼叫 ownmind_init MCP tool。',
    '鐵律必須嚴格遵守。衝突時以 OwnMind 為準。存取記憶時顯示【OwnMind vX.X.X】{類型}：{內容} 格式標記。',
    '觸發詞：「記起來」「學起來」「新增鐵律」「交接」「整理記憶」。',
  ].join('\n');

  it('an untouched legacy block is replaced, not duplicated', () => {
    const { target, snippet } = fixture(`# My rules\n\nkeep me\n\n${LEGACY}\n`);
    assert.match(
      run(['--target', target, '--marker', 'ownmind-rules', '--snippet', snippet, '--legacy-claude']),
      /^written:/
    );
    const body = read(target);
    assert.doesNotMatch(body, /OwnMind 個人記憶系統/, 'the stale block should be gone');
    assert.match(body, /rule one/);
    assert.match(body, /keep me/, "the user's own rules are untouched");
  });

  it('a legacy block the user edited is left alone and reported', () => {
    const edited = `${LEGACY}\n這行是我自己加的，不要動它\n`;
    const { target, snippet } = fixture(`# My rules\n\n${edited}\n`);
    assert.match(
      run(['--target', target, '--marker', 'ownmind-rules', '--snippet', snippet, '--legacy-claude']),
      /^legacy-kept:/,
      'the caller has to be able to tell the user there is an old block to remove'
    );
    const body = read(target);
    assert.match(body, /這行是我自己加的，不要動它/);
    assert.match(body, /rule one/, 'the new block still goes in');
  });

  it('does not touch a legacy block unless asked', () => {
    const { target, snippet } = fixture(`${LEGACY}\n`);
    run(['--target', target, '--marker', 'ownmind-rules', '--snippet', snippet]);
    assert.match(read(target), /OwnMind 個人記憶系統/, 'no --legacy-claude, no migration');
  });

  it('a second run after migration is a no-op on the user content', () => {
    const { target, snippet } = fixture(`# My rules\n\nkeep me\n\n${LEGACY}\n`);
    run(['--target', target, '--marker', 'ownmind-rules', '--snippet', snippet, '--legacy-claude']);
    const first = read(target);
    run(['--target', target, '--marker', 'ownmind-rules', '--snippet', snippet, '--legacy-claude']);
    assert.equal(read(target), first, 'the second run must change nothing');
  });
});
