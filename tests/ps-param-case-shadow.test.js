// PowerShell variable names ignore case, so inside a function with a `-Api` parameter the line
// `$api = ''` empties the parameter itself. That one line made every Windows install skip the
// OwnMind server and fall back to GitHub's previous release, and only the first real Windows run
// in CI showed it. This test fails when any function in the PowerShell scripts assigns to a
// variable whose name matches one of its parameters except in case.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ps1')) out.push(full);
  }
  return out;
}

/** Every `function Name { param(...) ... }` whose body assigns to a case-variant of a parameter. */
export function caseShadows(text) {
  const found = [];
  const fn = /function\s+([\w-]+)\s*\{/g;
  let m;
  while ((m = fn.exec(text))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < text.length && depth) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') depth -= 1;
      i += 1;
    }
    const body = text.slice(start, i);
    const pm = /param\s*\(([\s\S]*?)\)\s*\r?\n/.exec(body);
    if (!pm) continue;
    const params = [...pm[1].matchAll(/\$(\w+)/g)].map((x) => x[1]);
    const lower = new Set(params.map((p) => p.toLowerCase()));
    for (const line of body.slice(pm.index + pm[0].length).split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      for (const a of line.matchAll(/\$(\w+)\s*=(?!=)/g)) {
        if (lower.has(a[1].toLowerCase()) && !params.includes(a[1])) {
          found.push(`${m[1]}: $${a[1]} = (parameter $${params.find((p) => p.toLowerCase() === a[1].toLowerCase())})`);
        }
      }
    }
  }
  return found;
}

test('the check catches the line that broke Windows downloads', () => {
  const broken = "function Get-X {\n  param([string]$Api)\n  $api = ''\n  if ($Api) { $api = $Api.TrimEnd('/') }\n}\n";
  assert.equal(caseShadows(broken).length, 2);
  const fixed = "function Get-X {\n  param([string]$Api)\n  $apiBase = ''\n  if ($Api) { $apiBase = $Api.TrimEnd('/') }\n}\n";
  assert.deepEqual(caseShadows(fixed), []);
});

test('no PowerShell function assigns to a case-variant of its own parameter', () => {
  const problems = [];
  for (const file of walk(repoRoot)) {
    for (const p of caseShadows(fs.readFileSync(file, 'utf8'))) problems.push(`${path.relative(repoRoot, file)}: ${p}`);
  }
  assert.deepEqual(problems, []);
});
