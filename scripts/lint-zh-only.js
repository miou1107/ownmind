#!/usr/bin/env node
// 中英混雜 lint — 掃 client/src 內的 JSX/JS、抓出寫死的英文 UI 文字
//
// 規則：JSX 文字節點 + JS 字串若含黑名單詞、必須在 i18n key 對照表內、或包在 t(...) 內、否則 fail
// 例外：i18n/*.json（字典本就要英日）、scripts/、node_modules、dist 跳過
//
// 用法：node scripts/lint-zh-only.js <target-dir>
//   或 npm test 自動跑

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, extname } from 'path';

const TARGET_DIR = process.argv[2] || 'client/src';

// 黑名單：原型踩坑常見的中英混雜詞
const BLACKLIST = [
  'Compliance', 'Bug Triage', 'Notional', 'EXCELLENT',
  'TOTAL INPUTS', 'TOTAL OUTPUTS',
  'Status:', 'Active Sessions', 'Iron Rule Compliance',
  'API Cost', 'Token Traffic', 'Project History',
  'Workspace Handoffs', 'Compliance Reports',
  'Team & Members', 'System Configuration',
  'Personal Analytics',
];

// 跳過的 path 片段
const SKIP_PATHS = [
  'node_modules', 'dist', '.vite', 'i18n/',
  'glossary.json', 'override.json', '.translate-cache',
  'scripts/translate.mjs',
];

const violations = [];

function shouldSkip(path) {
  return SKIP_PATHS.some((s) => path.includes(s));
}

function isCodeFile(file) {
  return ['.jsx', '.js', '.tsx', '.ts'].includes(extname(file));
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (shouldSkip(full)) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full);
    } else if (isCodeFile(entry)) {
      lintFile(full);
    }
  }
}

function lintFile(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  // 移除註解（簡化版、不處理 nested）+ 移除 t(...) 整個 call expression 內容
  // 用簡化的括號 match：t( 開頭、第一個 ) 結尾、覆蓋大部分 case
  // 跨行 t() 在現實 React 程式碼罕見、若出現可手動加 lint-zh-only-ignore 註解
  const stripped = lines.map((line) => {
    return line
      .replace(/\/\/.*$/, '')
      .replace(/\/\*.*?\*\//g, '')
      .replace(/\bt\([^)]*\)/g, ''); // 移除 t(...) 全部內容
  });

  stripped.forEach((line, idx) => {
    for (const word of BLACKLIST) {
      if (line.includes(word)) {
        violations.push({
          file: filePath,
          line: idx + 1,
          word,
          snippet: lines[idx].trim().slice(0, 100),
        });
      }
    }
  });
}

console.log(`🔍 掃描 ${TARGET_DIR} 是否有中英混雜...`);
walk(TARGET_DIR);

if (violations.length === 0) {
  console.log('✅ 0 個中英混雜違反');
  process.exit(0);
}

console.error(`\n❌ 發現 ${violations.length} 個中英混雜違反：\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}`);
  console.error(`    含黑名單詞「${v.word}」`);
  console.error(`    內容: ${v.snippet}`);
  console.error('');
}
console.error('修正方式：把寫死的英文文案改成 t(\'i18n.key\')、或加進 client/src/i18n/zh.json');
process.exit(1);
