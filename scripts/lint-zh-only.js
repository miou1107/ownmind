#!/usr/bin/env node
// Mixed Chinese-English lint — scans JSX/JS under client/src for hard-coded English UI text.
//
// Rule: a JSX text node or a JS string containing a blacklisted word must either appear in
//       the i18n key mapping or be wrapped in t(...); otherwise it fails.
// Exceptions: i18n/*.json (the dictionary itself must contain English/Japanese), scripts/,
//             node_modules, dist are skipped.
//
// Usage: node scripts/lint-zh-only.js <target-dir>
//        or `npm test` invokes it automatically.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, extname } from 'path';

const TARGET_DIR = process.argv[2] || 'client/src';

// Blacklist: mixed-language words we've stumbled on during prototyping.
const BLACKLIST = [
  'Compliance', 'Bug Triage', 'Notional', 'EXCELLENT',
  'TOTAL INPUTS', 'TOTAL OUTPUTS',
  'Status:', 'Active Sessions', 'Iron Rule Compliance',
  'API Cost', 'Token Traffic', 'Project History',
  'Workspace Handoffs', 'Compliance Reports',
  'Team & Members', 'System Configuration',
  'Personal Analytics',
];

// Path segments to skip.
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
  // v1.26.123 — split on \r?\n, not \n. A CRLF checkout leaves a carriage return at the end
  // of every line, and `\r` is a line terminator to a JS regex: `.` will not cross it, so
  // `/\/\/.*$/` finds no match and the comment stripping below silently strips nothing.
  // Every comment in the tree is then linted as if it were UI text. Locally that failed
  // `npm test` at the lint step, before a single test ran, on a file nobody had touched —
  // while CI stayed green because the Linux and macOS checkouts use LF.
  // Same shape as the strip in tests/migration-017-bug-reports-id-serial.test.js: a strip
  // that quietly strips nothing reads exactly like one that had nothing to strip.
  const lines = content.split(/\r?\n/);

  // Strip comments (simplified — no nested handling) + strip whole t(...) call expressions.
  // Naive paren match: from `t(` to the first `)`; covers most cases.
  // Multi-line t() is rare in real React code; if it shows up, add a lint-zh-only-ignore comment.
  const stripped = lines.map((line) => {
    return line
      .replace(/\/\/.*$/, '')
      .replace(/\/\*.*?\*\//g, '')
      .replace(/\bt\([^)]*\)/g, ''); // strip everything inside t(...)
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

console.log(`🔍 Scanning ${TARGET_DIR} for mixed Chinese-English text...`);
walk(TARGET_DIR);

if (violations.length === 0) {
  console.log('✅ 0 violations');
  process.exit(0);
}

console.error(`\n❌ Found ${violations.length} mixed-language violation(s):\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}`);
  console.error(`    contains blacklisted word "${v.word}"`);
  console.error(`    snippet: ${v.snippet}`);
  console.error('');
}
console.error('Fix: replace the hard-coded English with t(\'i18n.key\'), or add it to client/src/i18n/zh.json.');
process.exit(1);
