/**
 * What install.sh prints when `npm install` fails.
 *
 * Until v1.30.15 the answer was "a canned suggestion and nothing else": the step ran
 * `npm install -q 2>/dev/null`, so a proxy refusal, a permissions error under node_modules, a
 * registry outage and a lockfile conflict all arrived as "Try: npm install -g npm@latest and
 * retry", which addresses none of them. The script then exits 1 with the reason already
 * destroyed, so there is nothing left to look at afterwards either.
 *
 * The repair kept npm's stream in $INSTALL_LOG and printed the tail — and a review of that
 * repair found it reading back from a handle that is not always a file. `INSTALL_LOG` falls
 * back to `/dev/stderr` when ~/.ownmind-logs cannot be written, and there `-s` answers a
 * question nobody asked: false on a terminal (so the script would claim npm wrote nothing
 * while its error sat on screen), true under `bash install.sh > out.log 2>&1` (so `tail` would
 * print the last 20 lines of the whole transcript — git clone progress, [INFO] lines — under
 * the heading "What npm said"). Hence INSTALL_LOG_IS_FILE, and hence these three cases.
 *
 * The block under test is lifted out of install.sh by text rather than retyped, so a rename or
 * a rewrite of that region fails here instead of silently leaving this file testing a fossil.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';
import { spawnBashScript, toBashPath } from './helpers/bash-script.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The contiguous region of install.sh from the log-file setup through the end of the npm
 * block. Both halves are needed together: the defect being pinned is precisely that the
 * reader and the writer of INSTALL_LOG disagreed about what it is.
 */
function extractNpmBlock() {
  const lines = fs.readFileSync(path.join(repoRoot, 'install.sh'), 'utf8').split('\n');
  const start = lines.findIndex((l) => /^INSTALL_LOG_DIR=/.test(l));
  assert.notEqual(start, -1, 'install.sh no longer sets INSTALL_LOG_DIR at the start of a line');
  const npmLine = lines.findIndex((l) => /^npm_status=0$/.test(l));
  assert.notEqual(npmLine, -1, 'install.sh no longer opens the dependency step with `npm_status=0`');
  assert.ok(npmLine > start, 'the log file must be created before the step that writes to it');
  // The block contains a nested if/elif/else, so the first column-0 `fi` after it closes the
  // branch and not the block. The one that matters is the one after the step gives up.
  const exitLine = lines.findIndex((l, i) => i > npmLine && /^\s+exit 1$/.test(l));
  assert.notEqual(exitLine, -1, 'the npm step no longer aborts the install');
  const end = lines.findIndex((l, i) => i > exitLine && /^fi$/.test(l));
  assert.notEqual(end, -1, 'could not find the end of the npm block');
  return lines.slice(start, end + 1).join('\n');
}

/**
 * Runs that region with npm replaced by a stub, so no network and no install happen.
 *
 * @param {object} o
 * @param {string} o.npmStderr     what the fake npm writes to its stderr before failing
 * @param {boolean} o.logWritable  false makes ~/.ownmind-logs unusable, forcing the
 *                                 /dev/stderr fallback
 */
function runNpmFailure({ npmStderr = 'npm ERR! code E401\nnpm ERR! 401 Unauthorized - GET https://registry.example/pkg', logWritable = true } = {}) {
  const home = tempDir('install-npm-fail-');
  fs.mkdirSync(path.join(home, '.ownmind', 'mcp'), { recursive: true });

  if (!logWritable) {
    // A regular FILE where the script expects a directory: `mkdir -p` fails, and so does
    // creating anything under it. Chmod would not do this on Windows, where NTFS ignores it.
    fs.writeFileSync(path.join(home, '.ownmind-logs'), 'not a directory\n');
  }

  const binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const npmStub = path.join(binDir, 'npm');
  // An empty string must produce a zero-byte stream, not a bare newline: one byte is enough for
  // `-s` to call the log non-empty, which is the difference the "wrote nothing" case is about.
  const emit = npmStderr === '' ? ':' : `printf '%s\\n' ${JSON.stringify(npmStderr)} >&2`;
  fs.writeFileSync(npmStub, `#!/bin/sh\n${emit}\nexit 1\n`);
  fs.chmodSync(npmStub, 0o755);

  const script = [
    'set -eE',
    // The real script defines this earlier; only its side effect of not existing matters here.
    'report_error() { :; }',
    `OWNMIND_DIR="$HOME/.ownmind"`,
    extractNpmBlock(),
  ].join('\n');

  // A file, not `bash -c` — see tests/helpers/bash-script.js: on Windows the two disagree
  // about backslashes, so a generated script arrives as a different script than the one
  // written here. HOME is passed in bash's own path spelling for the same reason.
  const r = spawnBashScript(script, {
    encoding: 'utf8',
    env: { ...process.env, HOME: toBashPath(home), PATH: `${toBashPath(binDir)}:${process.env.PATH}` },
  });
  return { ...r, home, output: `${r.stdout}${r.stderr}` };
}

describe('install.sh — what a failed npm install tells you', () => {
  before(() => { extractNpmBlock(); });

  it('fails the install rather than continuing', () => {
    assert.equal(runNpmFailure().status, 1);
  });

  it("prints npm's own words, not only the canned suggestion", () => {
    const { output } = runNpmFailure();
    assert.match(output, /401 Unauthorized/,
      'npm is the only thing that knows why npm failed');
    assert.match(output, /npm ERR! code E401/);
  });

  it('keeps the full log and names where it is', () => {
    const { output, home } = runNpmFailure();
    assert.match(output, /Full log: /);
    const logDir = path.join(home, '.ownmind-logs');
    const logs = fs.readdirSync(logDir).filter((f) => f.startsWith('install-'));
    assert.equal(logs.length, 1, 'exactly one log for one run');
    assert.match(fs.readFileSync(path.join(logDir, logs[0]), 'utf8'), /401 Unauthorized/);
  });

  it('still offers the npm-upgrade suggestion, now as a fallback rather than the whole answer', () => {
    const { output } = runNpmFailure();
    assert.match(output, /If it names no cause, try: npm install -g npm@latest/);
  });

  it('says nothing was written when npm really did write nothing', () => {
    const { output } = runNpmFailure({ npmStderr: '' });
    assert.match(output, /npm wrote no output at all/);
    assert.doesNotMatch(output, /Full log: /, 'there is no tail worth pointing at');
  });

  describe('when ~/.ownmind-logs cannot be written and INSTALL_LOG falls back to /dev/stderr', () => {
    it("points at the error already on screen instead of claiming nothing was captured", () => {
      const { output } = runNpmFailure({ logWritable: false });
      assert.match(output, /401 Unauthorized/, "npm's error still has to reach the user");
      assert.match(output, /printed above/);
      assert.doesNotMatch(output, /npm wrote no output at all/,
        'the error is visible; saying it was not is worse than saying nothing');
    });

    it('does not tail /dev/stderr back into the output', () => {
      const { output } = runNpmFailure({ logWritable: false });
      assert.doesNotMatch(output, /Full log: \/dev\/stderr/,
        '/dev/stderr is not a log anyone can go back and read');
      // The marker the fake npm emits appears once, from npm itself. A tail of a redirected
      // stderr would print it a second time.
      assert.equal(output.match(/401 Unauthorized/g).length, 1);
    });

    it('still fails the install', () => {
      assert.equal(runNpmFailure({ logWritable: false }).status, 1);
    });
  });
});
