#!/usr/bin/env node
// archive-update-cli.mjs: the shell side of shared/archive-update.js, for an OwnMind install
// unpacked from a release archive (a .release file and no .git).
//
// interactive-upgrade.sh / .ps1 run it instead of their git steps, and check-sync.sh / .ps1
// run it with --check for their L1 line.
//
// Usage:  node archive-update-cli.mjs [--dir <ownmind dir>] [--check]
// Output: one line on stdout
//   UPDATED vX.Y.Z               the install moved to that release and the installer re-ran
//   CURRENT vX.Y.Z               it already has the server's release
//   FAILED <reason>              nothing changed, except after `reconfigure` (the new release is
//                                in place and the next run re-runs the installer) and
//                                `swap_pending` / `swap` (part of the code is swapped; the next
//                                run resumes from the journal, without a download)
//   --check: in_sync release=vX.Y.Z | behind release=vX.Y.Z server=vA.B.C
//            | unknown release=vX.Y.Z reason=<code>
// Exit:   0 on UPDATED, CURRENT and every --check line; 1 on FAILED.
//
// The API key and URL come from the same place every hook reads them (resolve-credentials.cjs);
// the key never appears on a command line.

import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  runArchiveUpdate, readRelease, isArchiveInstall, serverRelease, compareReleases,
  CLEAN, APPLIED,
} from './archive-update.js';
import { tryAcquireUpdateLock, releaseUpdateLock } from './update-lock.js';
import { readCredentials } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const at = argv.indexOf('--dir');
const ownmindDir = path.resolve(at >= 0 ? argv[at + 1] : path.join(here, '..'));
const checkOnly = argv.includes('--check');

function credentials() {
  try {
    const { apiUrl, apiKey } = readCredentials();
    return { apiUrl: apiUrl || '', apiKey: apiKey || '' };
  } catch {
    return { apiUrl: '', apiKey: '' };
  }
}

async function check() {
  const release = readRelease(ownmindDir) || 'none';
  const { apiUrl, apiKey } = credentials();
  if (!apiUrl || !apiKey) return { line: `unknown release=${release} reason=no_credentials`, code: 0 };
  try {
    const server = await serverRelease({ apiUrl, apiKey });
    return compareReleases(server, release) > 0
      ? { line: `behind release=${release} server=${server}`, code: 0 }
      : { line: `in_sync release=${release}`, code: 0 };
  } catch (e) {
    return { line: `unknown release=${release} reason=${e?.code || 'unreachable'}`, code: 0 };
  }
}

async function update() {
  if (!isArchiveInstall(ownmindDir)) return { line: 'FAILED not_archive_install', code: 1 };
  const lockFile = path.join(ownmindDir, '.update-lock');
  const lock = tryAcquireUpdateLock(lockFile);
  if (!lock.acquired) return { line: `FAILED ${lock.reason === 'lock_held' || lock.reason === 'displaced' ? 'lock_held' : 'lock'}`, code: 1 };
  try {
    const { apiUrl, apiKey } = credentials();
    const r = await runArchiveUpdate({
      ownmindDir, apiUrl, apiKey, execFile: promisify(execFileCb),
      // Refreshes the lock's time after each long step, so a slow network does not make it stale.
      keepAlive: () => { const t = new Date(); fs.utimesSync(lockFile, t, t); },
      logEvent: (event, details) => {
        if (event === 'update_failed' || event === 'update_swap_pending') {
          process.stderr.write(`archive-update: ${event} ${JSON.stringify(details)}\n`);
        }
      },
    });
    if (r.outcome === APPLIED) return { line: `UPDATED ${r.to}`, code: 0 };
    if (r.outcome === CLEAN) return { line: `CURRENT ${r.to || r.from}`, code: 0 };
    return { line: `FAILED ${r.reason || r.outcome}`, code: 1 };
  } finally {
    // The lock is runtime state: the update never moves it, so it is released where it was taken.
    releaseUpdateLock(lockFile, lock.token);
  }
}

try {
  const { line, code } = checkOnly ? await check() : await update();
  console.log(line);
  process.exitCode = code;
} catch (e) {
  console.log(`FAILED ${e?.code || 'unknown'}`);
  process.stderr.write(`archive-update: ${String(e?.message || e).split(/\r?\n/)[0]}\n`);
  process.exitCode = 1;
}
