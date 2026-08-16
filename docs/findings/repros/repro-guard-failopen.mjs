// Does the path guard fail OPEN, and in which situations?
//
// The Windows CI evidence is a spelling mismatch: git answers with the long form of the
// temp directory while the tool hands over the 8.3 short form, and the guard, unable to
// line the two up, decides the file is outside the repo and allows the edit.
//
// Windows is not reachable from here, but the same shape is: on a case-insensitive
// volume two spellings of one directory are both valid, and neither realpath nor
// path.relative reconciles them. A file about to be created in a directory that does not
// exist yet is a second, more ordinary way in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { fileURLToPath } from 'node:url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { findGuardViolation, resolveRepo } = await import(path.join(REPO, 'hooks/lib/path-guard.js'));

const GUARD = {
  id: 412,
  type: 'team_standard',
  title: 'ci ownership belongs to the colleague',
  repo_match: 'guarded-monorepo',
  paths: ['ci/**', '.gitlab-ci.yml'],
  owner: 'Colleague',
};

const S = fs.mkdtempSync(path.join(os.tmpdir(), 'om-failopen-'));
function makeRepo(name) {
  const dir = path.join(S, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://example.com/guarded-monorepo.git']);
  return dir;
}
const verdict = (v) => (v ? '擋住' : '放行 ← 金鑰／別人的檔案改得下去');

console.log('=== 對照組：一般情況，檔案已經存在 ===');
{
  const repo = makeRepo('plain');
  const f = path.join(repo, 'ci/projects.yml');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'x\n');
  console.log(`  ${verdict(findGuardViolation(f, [GUARD]))}  ci/projects.yml`);
}

console.log('\n=== 情況一：同一個資料夾，大小寫寫法不同 ===');
{
  const repo = makeRepo('CaseTest');
  const f = path.join(repo, 'ci/projects.yml');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'x\n');
  const other = f.replace(`${S}${path.sep}CaseTest`, `${S}${path.sep}casetest`);
  console.log(`  這個檔案讀得到嗎：${fs.existsSync(other)}`);
  if (fs.existsSync(other)) {
    console.log(`  git 說根目錄在：   ${resolveRepo(other)?.root}`);
    console.log(`  ${verdict(findGuardViolation(other, [GUARD]))}  同一個檔案，換個大小寫寫法`);
  } else {
    console.log('  （這顆磁碟分大小寫，這條路走不通）');
  }
}

console.log('\n=== 情況二：要新增的檔案，它的資料夾還不存在 ===');
{
  const repo = makeRepo('newdir');
  const f = path.join(repo, 'ci/templates/brand-new.yml');
  console.log(`  資料夾存在嗎：${fs.existsSync(path.dirname(f))}`);
  console.log(`  git 找得到根目錄嗎：${resolveRepo(f) ? '找得到' : '找不到'}`);
  console.log(`  ${verdict(findGuardViolation(f, [GUARD]))}  ci/templates/brand-new.yml（新資料夾）`);
}

console.log('\n=== 情況三：路徑中間插一段 . 或 .. ===');
{
  const repo = makeRepo('dots');
  const f = path.join(repo, 'ci/projects.yml');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'x\n');
  const weird = path.join(repo, 'docs', '..', 'ci', 'projects.yml');
  console.log(`  ${verdict(findGuardViolation(weird, [GUARD]))}  docs/../ci/projects.yml`);
}

console.log('\n=== 情況四：透過捷徑（symlink）指過去 ===');
{
  const repo = makeRepo('viasymlink');
  const f = path.join(repo, 'ci/projects.yml');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'x\n');
  const link = path.join(S, 'shortcut');
  try {
    fs.symlinkSync(repo, link);
    console.log(`  ${verdict(findGuardViolation(path.join(link, 'ci/projects.yml'), [GUARD]))}  用捷徑指到同一個檔案`);
  } catch (e) { console.log(`  （做不出捷徑：${e.code}）`); }
}

fs.rmSync(S, { recursive: true, force: true });
