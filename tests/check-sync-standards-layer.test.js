/**
 * bug-report id=27 — the diagnostic and the warning said opposite things.
 *
 * `check-sync.sh` answered `OVERALL:in_sync` on a machine whose UserPromptSubmit hook was
 * saying, on every prompt, that no standard could be checked here. Both were telling the
 * truth about different things: the script compares git HEAD, the server version and the
 * deployed files, and none of those is the rules cache the hooks actually read. From outside
 * there was no way to see that, so the reporter took the script's word and read the warning
 * as stale.
 *
 * So the script now reports on the rules cache as well, in its own layer.
 *
 * The script talks to the network for L1 and L2. These tests read the L4 line only and do not
 * assert on the others, so a machine with no route out still runs them.
 *
 * check-sync.ps1 carries the same layer and cannot run here. Its L4 block was run against
 * these same nine inputs under pwsh 7.4 and answered identically; anyone touching either copy
 * should do that again rather than trust the pair to stay in step on its own.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(repoRoot, 'scripts', 'check-sync.sh');

/**
 * @param {(home: string) => void} [prepare] populate the fake home before the run
 * @returns {{stdout: string, standards: string, overall: string}}
 */
function runCheckSync(prepare) {
  const home = tempDir('om-checksync-');
  const ownmindDir = path.join(home, '.ownmind');
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(path.join(ownmindDir, 'cache'), { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  // A version the L2 layer can read, so its failure mode does not depend on the network.
  fs.writeFileSync(path.join(ownmindDir, 'package.json'), JSON.stringify({ version: '1.30.17' }));
  if (prepare) prepare(home);

  const stdout = execFileSync('bash', [SCRIPT], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: home,
      OWNMIND_DIR: ownmindDir,
      CLAUDE_DIR: claudeDir,
    },
  });
  const line = (prefix) => (stdout.split('\n').find((l) => l.startsWith(prefix)) || '').trim();
  return { stdout, standards: line('L4_STANDARDS:'), overall: line('OVERALL:') };
}

function writeBundle(home, bundle) {
  fs.writeFileSync(
    path.join(home, '.ownmind', 'cache', 'enforcement.json'),
    JSON.stringify(bundle),
  );
}

test('no rules cache at all is reported, not passed over', () => {
  const { standards } = runCheckSync();

  assert.match(standards, /^L4_STANDARDS:never_synced/,
    'the layer the hooks actually read has to have a line of its own');
});

test('a machine with no rules cache never answers in_sync overall', () => {
  // This is the contradiction the report is about: the summary said everything was fine while
  // every turn on that machine was going unchecked.
  const { overall } = runCheckSync();

  assert.equal(overall, 'OVERALL:needs_upgrade',
    'the summary must not call a machine that enforces nothing in sync');
});

test('a populated cache reports in_sync and says how much is in it', () => {
  const { standards } = runCheckSync((home) => writeBundle(home, {
    selectors: [{ id: 1 }, { id: 2 }],
    guards: [{ id: 3 }],
    injectables: [{ id: 4 }, { id: 5 }, { id: 6 }],
  }));

  assert.match(standards, /^L4_STANDARDS:in_sync/);
  assert.match(standards, /entries=6/, `the count makes the claim checkable; got ${standards}`);
});

test('an account with nothing annotated is in_sync, not broken', () => {
  // Synced and empty is a legitimate state — it means this account has annotated no rules —
  // and it is a different fact from never having fetched anything.
  const { standards } = runCheckSync((home) => writeBundle(home, {
    selectors: [], guards: [], injectables: [],
  }));

  assert.match(standards, /^L4_STANDARDS:in_sync/);
  assert.match(standards, /entries=0/);
});

test('a path with backslashes in it is still read, not reported as unusable', () => {
  // Windows CI, 2026-09-01: a healthy cache came back `unreadable` on every run. Where
  // `cygpath` is absent the Windows path keeps its backslashes, and interpolated into a
  // JavaScript string literal `\U`, `\A`, `\T` are escape sequences — the read throws and the
  // machine is told its rules are corrupt. A directory named with backslashes reproduces that
  // on any platform.
  const home = tempDir('om-checksync-bs-');
  const ownmindDir = path.join(home, 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp');
  fs.mkdirSync(path.join(ownmindDir, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(ownmindDir, 'package.json'), JSON.stringify({ version: '1.30.17' }));
  fs.writeFileSync(
    path.join(ownmindDir, 'cache', 'enforcement.json'),
    JSON.stringify({ selectors: [{ id: 1 }], guards: [], injectables: [] }),
  );

  const stdout = execFileSync('bash', [SCRIPT], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, HOME: home, OWNMIND_DIR: ownmindDir, CLAUDE_DIR: path.join(home, '.claude') },
  });

  const standards = (stdout.split('\n').find((l) => l.startsWith('L4_STANDARDS:')) || '').trim();
  assert.match(standards, /^L4_STANDARDS:in_sync entries=1/, `got ${standards}`);
});

test('a cache the hooks would refuse reads as unusable, whatever shape it is', () => {
  // Every one of these is a file that exists and parses, and that readEnforcementBundle
  // rejects. Reporting them as an empty-but-valid cache would put the diagnostic back where
  // it started: agreeing that everything is fine while nothing is enforced.
  const refused = ['{"selectors":null}', '{"selectors":{"a":1}}', '[1,2,3]', '"hello"', '3'];
  for (const body of refused) {
    const { standards } = runCheckSync((home) => {
      fs.writeFileSync(path.join(home, '.ownmind', 'cache', 'enforcement.json'), body);
    });
    assert.match(standards, /^L4_STANDARDS:unreadable/, `${body} was accepted as a cache`);
  }
});

test('a cache that cannot be parsed reads as unusable, not as empty', () => {
  // The hooks treat an unreadable bundle exactly like a missing one, so the diagnostic has to
  // agree with them rather than reporting a file that exists as if it worked.
  const { standards, overall } = runCheckSync((home) => {
    fs.writeFileSync(path.join(home, '.ownmind', 'cache', 'enforcement.json'), '{ "selectors": [');
  });

  assert.match(standards, /^L4_STANDARDS:unreadable/);
  assert.doesNotMatch(overall, /^OVERALL:in_sync$/);
});
