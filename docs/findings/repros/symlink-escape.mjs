import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { findGuardViolation, resolveRepo } = await import(path.join(REPO, 'hooks/lib/path-guard.js'));
const G = { id: 412, type: 'team_standard', title: 't', repo_match: 'guarded-monorepo', paths: ['ci/**'], owner: 'C' };
const S = fs.mkdtempSync(path.join(os.tmpdir(), 'om-symesc-'));
const repo = path.join(S, 'guarded'); fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', repo]);
execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://example.com/guarded-monorepo.git']);
const outside = path.join(S, 'outside'); fs.mkdirSync(outside);
fs.symlinkSync(outside, path.join(repo, 'ci'));   // repo/ci -> somewhere else entirely
const target = path.join(repo, 'ci', 'projects.yml');
console.log('  repo/ci 是不是捷徑：', fs.lstatSync(path.join(repo,'ci')).isSymbolicLink());
console.log('  git 說它屬於哪個專案：', resolveRepo(target)?.root ?? '(不屬於任何專案)');
console.log('  relPath：', resolveRepo(target)?.relPath ?? '-');
console.log('  結果：', findGuardViolation(target, [G]) ? '擋住' : '放行 ← 逃出去了');
fs.rmSync(S, { recursive: true, force: true });
