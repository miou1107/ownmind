// The awkward git topologies, against the new resolveRepo.
//
// Asking git for the prefix removes the string-subtraction bug, but git answers about
// whatever repository it is standing in - and "whatever it is standing in" is exactly what
// worktrees, submodules and nested repos make interesting. Climbing to the nearest existing
// ancestor is the other new behaviour worth pointing at a topology that can punish it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { fileURLToPath } from 'node:url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { resolveRepo, findGuardViolation } = await import(path.join(REPO, 'hooks/lib/path-guard.js'));

const GUARD = {
  id: 412, type: 'team_standard', title: 'ci belongs to the colleague',
  repo_match: 'guarded-monorepo', paths: ['ci/**', '.gitlab-ci.yml'], owner: 'Colleague',
};
const S = fs.mkdtempSync(path.join(os.tmpdir(), 'om-edge-'));
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function mkRepo(name, remote = 'https://example.com/guarded-monorepo.git') {
  const d = path.join(S, name);
  fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', d]);
  execFileSync('git', ['-C', d, 'remote', 'add', 'origin', remote]);
  fs.writeFileSync(path.join(d, 'seed.txt'), 'x\n');
  git(d, 'add', '.');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed');
  return d;
}
const show = (label, file, expect) => {
  const r = resolveRepo(file);
  const v = findGuardViolation(file, [GUARD]);
  const got = r ? r.relPath : '(找不到專案)';
  const ok = expect === undefined ? '' : (got === expect ? '  ✔' : `  ✘ 期望 ${expect}`);
  console.log(`  ${(v ? '擋住' : '放行').padEnd(4)}  relPath=${String(got).padEnd(34)} ${label}${ok}`);
};

console.log('=== 1. repo 根目錄的檔案（prefix 是空的）===');
{
  const d = mkRepo('root-level');
  show('.gitlab-ci.yml 在根目錄', path.join(d, '.gitlab-ci.yml'), '.gitlab-ci.yml');
  show('README.md 在根目錄（不該擋）', path.join(d, 'README.md'), 'README.md');
}

console.log('\n=== 2. git worktree（.git 是檔案不是資料夾）===');
{
  const main = mkRepo('wt-main');
  const wt = path.join(S, 'wt-linked');
  git(main, 'worktree', 'add', '-q', '-b', 'side', wt);
  console.log(`  .git 是檔案嗎：${fs.statSync(path.join(wt, '.git')).isFile()}`);
  show('worktree 裡已存在的資料夾', path.join(wt, 'ci', 'x.yml'), 'ci/x.yml');
  show('worktree 裡還不存在的資料夾', path.join(wt, 'ci', 'new', 'y.yml'), 'ci/new/y.yml');
}

console.log('\n=== 3. submodule（子專案有自己的 origin）===');
{
  const inner = mkRepo('sub-inner', 'https://example.com/some-other-project.git');
  const outer = mkRepo('sub-outer');
  try {
    execFileSync('git', ['-C', outer, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'vendor/inner'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    // The submodule's own origin is a different project, so the guard must NOT fire inside it
    // even though the path spells ci/ and the parent repo is the guarded one.
    show('子專案裡的 ci/x.yml（子專案不是被管的那個，不該擋）', path.join(outer, 'vendor', 'inner', 'ci', 'x.yml'));
    show('外層 repo 自己的 ci/x.yml（該擋）', path.join(outer, 'ci', 'x.yml'), 'ci/x.yml');
  } catch (e) { console.log(`  （這台 git 不讓本機路徑當 submodule：${String(e.message).slice(0, 60)}）`); }
}

console.log('\n=== 4. 巢狀 repo：被管的 repo 裡面又有一個獨立 repo ===');
{
  const outer = mkRepo('nest-outer');
  const innerDir = path.join(outer, 'ci', 'vendored');
  fs.mkdirSync(innerDir, { recursive: true });
  execFileSync('git', ['init', '-q', innerDir]);
  execFileSync('git', ['-C', innerDir, 'remote', 'add', 'origin', 'https://example.com/some-other-project.git']);
  show('內層獨立 repo 裡的檔案（內層 origin 不同，不該擋）', path.join(innerDir, 'thing.yml'));
}

console.log('\n=== 5. 完全不存在的深路徑，最近的祖先是別的 repo ===');
{
  const d = mkRepo('deep-missing');
  show('好幾層都不存在', path.join(d, 'ci', 'a', 'b', 'c', 'd', 'e.yml'), 'ci/a/b/c/d/e.yml');
  // The climb must not walk out of the repo and answer about a parent repository.
  const loose = path.join(S, 'not-a-repo', 'ci', 'x.yml');
  show('整段都在任何 repo 之外', loose);
}

console.log('\n=== 6. 路徑尾巴有斜線、以及相對路徑 ===');
{
  const d = mkRepo('odd-input');
  fs.mkdirSync(path.join(d, 'ci'), { recursive: true });
  show('結尾多一個斜線', `${path.join(d, 'ci', 'x.yml')}${path.sep}`);
  const prev = process.cwd();
  process.chdir(d);
  try { show('相對路徑 ci/x.yml', 'ci/x.yml', 'ci/x.yml'); } finally { process.chdir(prev); }
}

fs.rmSync(S, { recursive: true, force: true });
