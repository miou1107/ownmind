#!/usr/bin/env node
/**
 * scripts/privacy-scan.js — stop a commit that would publish someone's private data.
 *
 * This repository is public. Tests, examples, fixtures, CHANGELOG entries and commit messages
 * must use invented names (member-N, example-*). The script reads the lines a commit adds and
 * fails on:
 *   - any term listed in ~/.ownmind/privacy-terms.txt (one per line, `#` starts a comment).
 *     The list lives outside the repository on purpose: it is the private data.
 *   - any e-mail address outside the placeholder domains below.
 *
 * It prints the file and line of each hit and which rule matched, never the matched text, so
 * running it in a shared terminal or a CI log does not leak what it found.
 *
 * Usage:
 *   node scripts/privacy-scan.js            # lines added in the staged diff
 *   node scripts/privacy-scan.js --message <file>   # a commit message file
 * Exit code 1 when anything matched, 0 otherwise.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ALLOWED_EMAIL_DOMAINS = [
  /(^|\.)example\.(com|org|net)$/i,
  /\.example$/i,
  /(^|\.)users\.noreply\.github\.com$/i,
  /^anthropic\.com$/i,
  /^localhost$/i,
];
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;

export function readTerms(file = path.join(os.homedir(), '.ownmind', 'privacy-terms.txt')) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.replace(/#.*/, '').trim())
      .filter((l) => l.length >= 2);
  } catch {
    return [];
  }
}

/**
 * @param {Array<{ file: string, line: number, text: string }>} lines
 * @param {string[]} terms
 * @returns {Array<{ file: string, line: number, rule: string }>}
 */
export function scanLines(lines, terms) {
  // Latin terms match as whole words, so a short name like "Al" does not fire inside "also";
  // terms with any other script (names in Chinese or Japanese) match anywhere.
  const escape = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matchers = terms.map((term) => (/^[\x20-\x7e]+$/.test(term)
    ? new RegExp(`(^|[^A-Za-z0-9_])${escape(term)}($|[^A-Za-z0-9_])`, 'i')
    : { test: (text) => text.toLowerCase().includes(term.toLowerCase()) }));
  const hits = [];
  for (const l of lines) {
    matchers.forEach((m, i) => {
      if (m.test(l.text)) hits.push({ file: l.file, line: l.line, rule: `privacy-terms.txt entry ${i + 1}` });
    });
    for (const m of l.text.matchAll(EMAIL)) {
      const domain = m[1];
      if (!ALLOWED_EMAIL_DOMAINS.some((re) => re.test(domain))) {
        hits.push({ file: l.file, line: l.line, rule: 'e-mail address outside the placeholder domains' });
      }
    }
  }
  return hits;
}

/** Added lines of a unified diff produced with -U0, with the new file's line numbers. */
export function addedLines(diff) {
  const out = [];
  let file = null;
  let next = 0;
  let prev = '';
  for (const raw of diff.split('\n')) {
    // A file header is "--- a/x" followed by "+++ b/x". An added line whose text starts with
    // "++ " also begins with "+++ ", so only the line right after a "--- " counts as a header.
    const isHeader = raw.startsWith('+++ ') && prev.startsWith('--- ');
    prev = raw;
    if (isHeader) {
      file = raw.slice(4).replace(/^b\//, '');
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { next = Number(hunk[1]); continue; }
    if (raw.startsWith('+') && file && file !== '/dev/null') {
      out.push({ file, line: next, text: raw.slice(1) });
      next += 1;
    }
  }
  return out;
}

function main(argv) {
  const terms = readTerms();
  let lines;
  const msgIdx = argv.indexOf('--message');
  if (msgIdx !== -1) {
    const file = argv[msgIdx + 1];
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((text, i) => ({ file: 'commit message', line: i + 1, text }));
  } else {
    const diff = execFileSync('git', ['diff', '--cached', '-U0', '--no-color'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    lines = addedLines(diff);
  }
  const hits = scanLines(lines, terms);
  if (terms.length === 0) {
    console.error('privacy-scan: ~/.ownmind/privacy-terms.txt is missing or empty; only e-mail addresses were checked.');
  }
  for (const h of hits) console.error(`privacy-scan: ${h.file}:${h.line} — ${h.rule}`);
  if (hits.length) {
    console.error(`privacy-scan: ${hits.length} hit(s). Replace them with invented values (member-N, example-*) before committing.`);
    return 1;
  }
  console.log(`privacy-scan: ${lines.length} added line(s) checked, nothing found.`);
  return 0;
}

const invoked = (() => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invoked) process.exit(main(process.argv.slice(2)));
