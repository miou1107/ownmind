import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every place the installer stops tells the AI what to do next (zero-touch-install, Task 10).
 *
 * The AI that runs the installer reads its output line by line:
 *   ERROR:<code>:<message> followed by FIX:<code>:<command>  - run the command, run the installer again
 *   ASK:<code>:<sentence>                                    - say the sentence to the person and stop
 * A stop with neither is a dead end: the AI sees a failure and has nothing it may do about it.
 *
 * This is a static check on the scripts: every `exit 1` (and the incomplete-install `exit 2`)
 * must have, within the six lines before it, an ERROR line and a FIX line, or an ASK line.
 * An exit that genuinely adds nothing (the function it follows already printed the lines) is
 * allowed with a `grammar-allow: <reason>` comment within the five lines before it (or on it); the
 * reason has to be a real sentence.
 */

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const FILES = [
  'scripts/bootstrap.sh',
  'scripts/bootstrap.ps1',
  'install.sh',
  'install.ps1',
  'scripts/install-helpers/fetch-release.sh',
  'scripts/install-helpers/fetch-release.ps1',
  'scripts/install-helpers/ensure-node-runtime.sh',
  'scripts/install-helpers/ensure-node-runtime.ps1',
];

const WINDOW = 6;
const EXIT = /\bexit [12]\b/;
const RETURN_FAIL = /\breturn (1|\$false|\$null)\b/;

// The functions that end a step of the install by returning a failure.
const FETCH_STOPS = ['ownmind_download_archive', 'ownmind_unpack_release', 'Get-OwnMindArchive', 'Expand-OwnMindRelease'];
const NODE_STOPS = ['ownmind_ensure_node', 'ownmind_node_use_private', 'Ensure-OwnMindNode', 'Use-OwnMindPrivateNode'];
const STOP_FUNCTIONS = {
  'scripts/bootstrap.sh': FETCH_STOPS,
  'scripts/bootstrap.ps1': FETCH_STOPS,
  'scripts/install-helpers/fetch-release.sh': FETCH_STOPS,
  'scripts/install-helpers/fetch-release.ps1': FETCH_STOPS,
  'scripts/install-helpers/ensure-node-runtime.sh': NODE_STOPS,
  'scripts/install-helpers/ensure-node-runtime.ps1': NODE_STOPS,
};
const ERROR_MARK = /ERROR:|\blog_err\b|\bLog-Err\b/;
const FIX_MARK = /FIX:|\blog_fix\b|\bLog-Fix\b/;
const ASK_MARK = /ASK:|\bownmind_ask_line\b|\bWrite-OwnMindAsk\b/;
// A call to a helper that always prints an ERROR line and then a FIX or an ASK line.
const STOP_MARK = /\bownmind_stop_write\b|\bWrite-OwnMindStopWrite\b|\bownmind_unpack_failed\b/;
const ALLOW = /grammar-allow:\s*(\S.{9,})/;

/**
 * The line ranges (0-based, inclusive) of the named functions: `name() {` in shell,
 * `function Name {` in PowerShell, found by matching braces.
 */
function functionRanges(lines, names) {
  const ranges = [];
  for (const name of names) {
    const start = lines.findIndex((l) => new RegExp(`^(function ${name}\\b|${name}\\(\\))`).test(l));
    if (start === -1) continue;
    let depth = 0;
    let opened = false;
    for (let i = start; i < lines.length; i += 1) {
      for (const ch of lines[i].replace(/'[^']*'|"[^"]*"/g, '')) {
        if (ch === '{') { depth += 1; opened = true; }
        if (ch === '}') depth -= 1;
      }
      if (opened && depth <= 0) { ranges.push([start, i]); break; }
    }
  }
  return ranges;
}

/**
 * The stops in `text` that have neither an ERROR+FIX pair nor an ASK nearby, and no allow comment.
 * An `exit` anywhere counts; so does a failing `return` (`return 1`, `return $false`,
 * `return $null`) inside the named stop functions, the helpers that end a step of the install.
 */
export function bareExits(text, stopFunctions = []) {
  const lines = text.split('\n');
  const inStopFunction = functionRanges(lines, stopFunctions);
  const bare = [];
  lines.forEach((line, i) => {
    const isReturn = RETURN_FAIL.test(line) && inStopFunction.some(([a, b]) => i >= a && i <= b);
    if (!EXIT.test(line) && !isReturn) return;
    if (/^\s*(#|\/\/)/.test(line)) return;
    const near = lines.slice(Math.max(0, i - WINDOW), i + 1);
    const ok = near.some((l) => ASK_MARK.test(l) || STOP_MARK.test(l))
      || (near.some((l) => ERROR_MARK.test(l)) && near.some((l) => FIX_MARK.test(l)));
    if (ok) return;
    if (lines.slice(Math.max(0, i - 5), i + 1).some((l) => ALLOW.test(l))) return;
    bare.push({ line: i + 1, text: line.trim() });
  });
  return bare;
}

describe('every installer stop is an instruction for the AI', () => {
  for (const rel of FILES) {
    it(`${rel}: no exit without ERROR+FIX, ASK or a reasoned grammar-allow`, () => {
      const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      const bare = bareExits(text, STOP_FUNCTIONS[rel] || []);
      assert.deepEqual(bare, [], `bare exits in ${rel}:\n${bare.map((b) => `  line ${b.line}: ${b.text}`).join('\n')}`);
    });
  }

  it('the checker itself sees a bare exit, accepts a pair, an ASK and a reasoned allow, and refuses an empty allow', () => {
    assert.equal(bareExits('echo hi\nexit 1\n').length, 1);
    assert.equal(bareExits('log_err x "y"\necho "FIX:c:cmd"\nexit 1\n').length, 0);
    assert.equal(bareExits('log_err x "y"\nexit 1\n').length, 1);
    assert.equal(bareExits('echo "ASK:no_network:text"\nexit 1\n').length, 0);
    assert.equal(bareExits('# grammar-allow: the callee already printed its lines\nexit 1\n').length, 0);
    assert.equal(bareExits('exit 1 # grammar-allow: x\n').length, 1);
  });

  it('the checker also sees a bare failing return inside a stop function, and nowhere else', () => {
    const sh = 'step() {\n  mkdir x || return 1\n}\nother() {\n  false || return 1\n}\n';
    assert.equal(bareExits(sh, ['step']).length, 1);
    assert.equal(bareExits(sh, []).length, 0);
    assert.equal(bareExits('step() {\n  ownmind_stop_write a b "$o"; return 1\n}\n', ['step']).length, 0);
    const ps = 'function Step {\n  Log-Err a "b"\n  return $false\n}\n';
    assert.equal(bareExits(ps, ['Step']).length, 1);
    assert.equal(bareExits('function Step {\n  Log-Err a "b"\n  Write-Host "FIX:retry_install:cmd"\n  return $false\n}\n', ['Step']).length, 0);
  });

  it('every FIX and ASK line has the code:payload shape', () => {
    for (const rel of FILES) {
      const code = fs.readFileSync(path.join(repoRoot, rel), 'utf8')
        .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
      for (const m of code.matchAll(/["']((?:FIX|ASK):[^"'\n]*)/g)) {
        assert.match(m[1], /^(FIX|ASK):[a-z_]+:\S/, `${rel}: malformed line "${m[1]}"`);
      }
    }
  });
});
