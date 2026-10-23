/**
 * shared/archive-update.js — updates for a machine that was installed without git.
 *
 * bootstrap.sh / bootstrap.ps1 install OwnMind from a release archive when the machine has no
 * usable git: ~/.ownmind then holds a `.release` file (vX.Y.Z, or `main` after a GitHub
 * fallback without tags) and no `.git`. Every git-based update path skips such a directory, so
 * without this file those machines would stay on the release they were installed with.
 *
 * The update swaps CODE only. What the client writes at runtime (the private Node in runtime/,
 * key files, caches, logs, markers: see STATE_ENTRIES) is never renamed, copied or deleted. A
 * Windows machine runs its private node.exe from inside ~/.ownmind\runtime, and Windows refuses
 * to rename a folder that holds a running program, so a whole-tree swap could never finish
 * there; and copying ~100 MB of runtime on every update would be waste everywhere.
 *
 *   1. ask the server which release it ships (HEAD /api/install/archive, header X-OwnMind-Release);
 *   2. stage it in `<dir>/.next/` (same volume as the live tree): download, unpack, check it has
 *      `.release` and the installer, `npm install --ignore-scripts` in `.next/mcp`, and the root
 *      dependencies scripts/update.sh installs, in `.next`;
 *   3. the code entries are the top-level entries of `.next/`. State entries are never in the
 *      archive; a code entry that collides with one stops the update before any rename;
 *   4. swap entry by entry with a journal (`<dir>/.swap-journal.json`): `<dir>/<e>` -> `.prev/<e>`,
 *      then `.next/<e>` -> `<dir>/<e>`, marking each entry done. `.release` goes last, so the live
 *      `.release` only names the new release once every other entry is in place;
 *   5. delete the journal and `.next`, then re-run the installer to rewrite the host configuration.
 *
 * Failure rules. Anything before the first rename leaves the live tree exactly as it was (the
 * staged `.next` is removed). A failure after some renames is RESUMED, never rolled back: the
 * journal stays, and the next run continues from the first entry not done (its new copy is still
 * in `.next`). Each entry's step is idempotent, so a run that stopped between the two renames of
 * one entry is finished correctly. An EBUSY/EPERM/EACCES rename (a running MCP server holding a
 * file in mcp/ on Windows) returns `{ outcome: FAILED, reason: 'swap_pending' }`. `.prev/` holds
 * the previous release's code for a person to fall back on; the upgraders sweep it after 7 days.
 *
 * Everything is injected (process runner, fetch, file system, clock, logger, lock keep-alive), as
 * in shared/auto-update.js, so the interesting half is testable without a server or a network.
 */

import fs from 'fs';
import path from 'path';
import { RELEASE_TAG } from './release-target.js';

export const SKIPPED = 'skipped';
export const CLEAN = 'clean';
export const APPLIED = 'applied';
export const FAILED = 'failed';

const HEAD_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const UNPACK_TIMEOUT_MS = 5 * 60_000;
const NPM_TIMEOUT_MS = 5 * 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
// The installer and npm print a lot; execFile kills a child whose output passes maxBuffer.
const OUTPUT_LIMIT = 32 * 1024 * 1024;

/** Names this module uses inside the live tree. */
export const NEXT_DIR = '.next';
export const PREV_DIR = '.prev';
export const SWAP_JOURNAL = '.swap-journal.json';
export const RECONFIGURE_PENDING = '.reconfigure-pending';
const DOWNLOAD_FILE = '.next.download';

/**
 * What the client writes under ~/.ownmind at runtime. Found by reading install.sh/.ps1, hooks/,
 * mcp/, shared/ and scripts/ for paths written under the OwnMind directory:
 *
 *   runtime/            the private Node (runtime/current is a symlink or a directory junction)
 *   credentials         key file (scripts/install-helpers/ensure-key-file.cjs, secure-key-files.cjs)
 *   cache/ state/       enforcement cache, init cache, session state (hooks/)
 *   logs/ reports/      hook and update logs, the self-check upload spool, touch reports
 *   git-hooks/          the git hook wrappers, and any hook of the user's own that install.sh kept
 *   bin/                run-scanner.sh, which the launchd/systemd units point at
 *   judge.json          the judge model choice
 *   queue.jsonl         the MCP's offline queue (mcp/offline.js)
 *   .node-path .no-usage-scanner .no-key-file .no-session-hook .no-monitor-mod .no-touch-report
 *   .no-self-check-upload .git-bash-path .session-hook-installed .last-update-check
 *   .last-mcp-update-check .last-usage-roundtrip .update-lock     markers and opt-outs
 *
 * plus this module's own names. None of them is ever in the archive; isStateEntry is the guard
 * that refuses a release that would put code where one of them lives.
 */
export const STATE_ENTRIES = new Set([
  'runtime', 'credentials', 'cache', 'state', 'logs', 'reports', 'git-hooks', 'bin', 'judge.json', 'queue.jsonl',
  '.node-path', '.no-usage-scanner', '.no-key-file', '.no-session-hook', '.no-monitor-mod', '.no-touch-report',
  '.no-self-check-upload', '.git-bash-path', '.session-hook-installed', '.last-update-check',
  '.last-mcp-update-check', '.last-usage-roundtrip', '.update-lock', '.git',
  NEXT_DIR, PREV_DIR, SWAP_JOURNAL, RECONFIGURE_PENDING, DOWNLOAD_FILE, '.swap-pending',
]);
export function isStateEntry(name) {
  return STATE_ENTRIES.has(name) || /^\.(no|last)-/.test(name) || name.startsWith('.update-lock');
}

/** -1, 0, 1 for two release names; anything that is not vX.Y.Z (such as `main`) sorts lowest. */
export function compareReleases(a, b) {
  const pa = String(a || '').match(RELEASE_TAG);
  const pb = String(b || '').match(RELEASE_TAG);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Is this directory an archive install (a .release file and no .git)? */
export function isArchiveInstall(ownmindDir, fileSystem = fs) {
  return fileSystem.existsSync(path.join(ownmindDir, '.release'))
    && !fileSystem.existsSync(path.join(ownmindDir, '.git'));
}

/** The release named by `<dir>/.release`, or '' when there is none. */
export function readRelease(ownmindDir, fileSystem = fs) {
  try {
    return fileSystem.readFileSync(path.join(ownmindDir, '.release'), 'utf8').split(/\r?\n/)[0].trim();
  } catch {
    return '';
  }
}

/**
 * The release the server ships, from HEAD /api/install/archive. Resolves to the tag, or throws
 * an Error whose `code` says why (http_<status>, no_release_header, or the fetch error's code).
 */
export async function serverRelease({ apiUrl, apiKey, fetch = globalThis.fetch }) {
  const res = await fetch(`${String(apiUrl).replace(/\/+$/, '')}/api/install/archive`, {
    method: 'HEAD',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`server answered ${res.status}`);
    err.code = `http_${res.status}`;
    throw err;
  }
  const tag = String(res.headers.get('x-ownmind-release') || '').trim();
  if (!RELEASE_TAG.test(tag)) {
    const err = new Error('server sent no X-OwnMind-Release');
    err.code = 'no_release_header';
    throw err;
  }
  return tag;
}

/** Is `p` a symlink or (on Windows) a directory junction? Node reports both as symbolic links. */
function isLink(fileSystem, p) {
  try { return fileSystem.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

const exists = (fileSystem, p) => fileSystem.existsSync(p) || isLink(fileSystem, p);

/** Remove a link without following it: unlink, or rmdir for a Windows directory junction. */
function removeLink(fileSystem, p) {
  try {
    fileSystem.unlinkSync(p);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    // A directory junction (and a directory symlink on Windows) refuses unlink with EPERM or
    // EISDIR; rmdir removes the link itself, never the directory it points to.
    fileSystem.rmdirSync(p);
  }
}

/**
 * Delete a tree without following a runtime/current link inside it. `.prev` and `.next` never
 * hold runtime/ by construction; the link is taken out first anyway, so no recursive delete can
 * ever reach the Node it points to, whatever the platform's rules for following links are.
 */
export function removeTree(fileSystem, dir) {
  if (!exists(fileSystem, dir)) return;
  if (isLink(fileSystem, dir)) { removeLink(fileSystem, dir); return; }
  const current = path.join(dir, 'runtime', 'current');
  if (isLink(fileSystem, current)) removeLink(fileSystem, current);
  fileSystem.rmSync(dir, { recursive: true, force: true });
}

/** Recursive copy that copies links as links, with a copy-on-write clone where the disk has one. */
function copyEntry(fileSystem, from, to) {
  fileSystem.cpSync(from, to, {
    recursive: true, force: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE,
  });
}

/**
 * The code entries of a staged release: its top-level entries, `.release` last. Throws (code
 * `state_collision`) when one of them is a name the client keeps its runtime state under.
 */
export function codeEntries(fileSystem, nextDir) {
  const names = fileSystem.readdirSync(nextDir).sort();
  const collisions = names.filter(isStateEntry);
  if (collisions.length > 0) {
    const err = new Error(`the release would overwrite runtime state: ${collisions.join(', ')}`);
    err.code = 'state_collision';
    throw err;
  }
  return [...names.filter((n) => n !== '.release'), ...(names.includes('.release') ? ['.release'] : [])];
}

/** Has `dir` everything an unpacked release must have? */
function isCompleteTree(fileSystem, dir, platform) {
  return fileSystem.existsSync(path.join(dir, '.release'))
    && fileSystem.existsSync(path.join(dir, platform === 'win32' ? 'install.ps1' : 'install.sh'));
}

/** PATH with `dir` in front, whichever spelling of the variable the environment uses. */
function withDirOnPath(env, dir, isWindows) {
  if (!dir || dir === '.') return { ...env };
  const sep = isWindows ? ';' : ':';
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const current = env[key] || '';
  if (current.split(sep).includes(dir)) return { ...env };
  return { ...env, [key]: current ? `${dir}${sep}${current}` : dir };
}

/**
 * The private Node, when `.node-path` names one inside `<dir>/runtime/`. The installer must
 * keep writing the hook commands with that absolute node (install.sh's OWNMIND_PRIVATE_NODE).
 */
export function privateNodeFor(ownmindDir, fileSystem = fs) {
  let named = '';
  try { named = fileSystem.readFileSync(path.join(ownmindDir, '.node-path'), 'utf8').split(/\r?\n/)[0].trim(); } catch { return ''; }
  if (!named) return '';
  const norm = (p) => p.replace(/\\/g, '/').toLowerCase();
  return norm(named).startsWith(`${norm(path.join(ownmindDir, 'runtime'))}/`) ? named : '';
}

/** Root dependencies scripts/update.sh installs (`needs_root_dep <name> <floor>`), as name@floor. */
export function rootDependencySpecs(updateShText) {
  const specs = [];
  for (const m of String(updateShText || '').matchAll(/^\s*if needs_root_dep ([@\w./-]+) ([\w.-]+); then/gm)) {
    specs.push(`${m[1]}@${m[2]}`);
  }
  return specs;
}

const errText = (e) => e?.code || e?.message || String(e).slice(0, 120);
const swapBlocked = (e) => ['EBUSY', 'EPERM', 'EACCES'].includes(e?.code);

/**
 * Bring an archive install up to the server's release.
 *
 * @param {object} deps
 * @param {string} deps.ownmindDir
 * @param {string} deps.apiUrl
 * @param {string} deps.apiKey
 * @param {Function} deps.execFile   promisified execFile(cmd, args, opts)
 * @param {Function} [deps.fetch]
 * @param {object} [deps.fileSystem]
 * @param {Function} [deps.logEvent] (type, details) => void
 * @param {Function} [deps.now]      () => Date
 * @param {string} [deps.platform]
 * @param {string} [deps.nodeBin]    the node to take npm from (npm sits beside it)
 * @param {object} [deps.env]
 * @param {Function} [deps.keepAlive] called after each long step (download, npm, root deps) and
 *                                   before the swap; the callers refresh the update lock's time
 *                                   there, so a slow network does not make it look stale
 * @param {boolean} [deps.reconfigure] re-run the installer after the swap (default true)
 * @returns {Promise<{outcome: string, from: string, to: string|null, reason?: string, version?: string|null}>}
 */
export async function runArchiveUpdate({
  ownmindDir,
  apiUrl,
  apiKey,
  execFile,
  fetch = globalThis.fetch,
  fileSystem = fs,
  logEvent = () => {},
  now = () => new Date(),
  platform = process.platform,
  nodeBin = process.execPath,
  env = process.env,
  keepAlive = () => {},
  reconfigure = true,
}) {
  const isWindows = platform === 'win32';
  const from = readRelease(ownmindDir, fileSystem);
  const nextDir = path.join(ownmindDir, NEXT_DIR);
  const prevDir = path.join(ownmindDir, PREV_DIR);
  const journalFile = path.join(ownmindDir, SWAP_JOURNAL);
  const downloadFile = path.join(ownmindDir, DOWNLOAD_FILE);
  const reconfigurePendingFile = path.join(ownmindDir, RECONFIGURE_PENDING);
  const nodeDir = nodeBin ? path.dirname(nodeBin) : '';
  const childEnv = withDirOnPath(env, nodeDir, isWindows);
  const ping = () => { try { keepAlive(); } catch { /* best effort */ } };

  const result = (outcome, extra = {}) => ({ outcome, from, to: null, ...extra });
  const fail = (step, err, extra = {}) => {
    logEvent('update_failed', { mode: 'archive', step, from, error: errText(err) });
    return result(FAILED, { reason: step, ...extra });
  };
  /** Remove what staging left; only ever called while no rename has happened. */
  const cleanStaging = () => {
    for (const p of [nextDir, downloadFile]) {
      try { removeTree(fileSystem, p); } catch (e) { logEvent('update_cleanup_failed', { mode: 'archive', path: path.basename(p), error: errText(e) }); }
    }
  };

  if (!from || !isArchiveInstall(ownmindDir, fileSystem)) {
    return result(SKIPPED, { reason: 'not_archive_install' });
  }

  const npmCommand = () => {
    const npmName = isWindows ? 'npm.cmd' : 'npm';
    const beside = nodeDir && nodeDir !== '.' ? path.join(nodeDir, npmName) : '';
    if (beside && fileSystem.existsSync(beside)) return isWindows ? `"${beside}"` : beside;
    return npmName;
  };
  const npm = (args, cwd) => execFile(npmCommand(), args, {
    cwd, timeout: NPM_TIMEOUT_MS, maxBuffer: OUTPUT_LIMIT, windowsHide: true, shell: isWindows, env: childEnv,
  });

  const writeJournal = (journal) => {
    const tmp = `${journalFile}.tmp`;
    fileSystem.writeFileSync(tmp, `${JSON.stringify(journal, null, 2)}\n`);
    fileSystem.renameSync(tmp, journalFile);
  };

  /**
   * Swap the entries the journal lists, from the first one not done. Returns null when every
   * entry is done (journal and .next removed), or the result to hand back (journal kept).
   */
  const runJournal = (journal) => {
    for (const entry of journal.entries) {
      if (journal.done.includes(entry)) continue;
      const live = path.join(ownmindDir, entry);
      const staged = path.join(nextDir, entry);
      const parked = path.join(prevDir, entry);
      if (!exists(fileSystem, staged)) {
        // Both renames of this entry happened before the journal could say so; or the new copy
        // is gone and the old one is still parked, in which case the old one goes back in place.
        if (!exists(fileSystem, live) && exists(fileSystem, parked)) {
          try { fileSystem.renameSync(parked, live); } catch (e) { return fail('swap_restore', e, { to: journal.to }); }
          logEvent('update_swap_restored', { mode: 'archive', entry, to: journal.to });
        }
      } else {
        if (exists(fileSystem, live)) {
          try {
            if (exists(fileSystem, parked)) removeTree(fileSystem, parked);
            fileSystem.renameSync(live, parked);
          } catch (e) {
            logEvent('update_swap_pending', { mode: 'archive', entry, from, to: journal.to, error: errText(e) });
            return swapBlocked(e) ? result(FAILED, { reason: 'swap_pending', to: journal.to }) : fail('swap', e, { to: journal.to });
          }
        }
        try {
          fileSystem.renameSync(staged, live);
        } catch (e) {
          // Put this entry's old copy back so the live tree is whole until the next run resumes.
          if (!exists(fileSystem, live) && exists(fileSystem, parked)) {
            try { fileSystem.renameSync(parked, live); } catch { /* the next run resumes from the journal */ }
          }
          logEvent('update_swap_pending', { mode: 'archive', entry, from, to: journal.to, error: errText(e) });
          return swapBlocked(e) ? result(FAILED, { reason: 'swap_pending', to: journal.to }) : fail('swap', e, { to: journal.to });
        }
      }
      journal.done.push(entry);
      try { writeJournal(journal); } catch { /* the per-entry check above makes a lost mark harmless */ }
    }
    try { fileSystem.unlinkSync(journalFile); } catch { /* already gone */ }
    try { removeTree(fileSystem, nextDir); } catch (e) { logEvent('update_cleanup_failed', { mode: 'archive', path: NEXT_DIR, error: errText(e) }); }
    return null;
  };

  /** Re-run the installer from the live tree. Returns null on success. */
  const runInstaller = async (to) => {
    if (!reconfigure) return null;
    try { fileSystem.writeFileSync(reconfigurePendingFile, `${to}\n`); } catch { /* best effort */ }
    const installEnv = { ...childEnv, OWNMIND_INSTALL_KEY: apiKey };
    const privateNode = privateNodeFor(ownmindDir, fileSystem);
    if (privateNode) {
      installEnv.OWNMIND_PRIVATE_NODE = '1';
      installEnv.OWNMIND_NODE = privateNode;
    }
    try {
      if (isWindows) {
        // install.ps1 reads the key and URL from the environment when it gets no arguments,
        // which keeps the key off the command line.
        await execFile('powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ownmindDir, 'install.ps1')],
          { cwd: ownmindDir, timeout: INSTALL_TIMEOUT_MS, maxBuffer: OUTPUT_LIMIT, windowsHide: true,
            env: { ...installEnv, OWNMIND_API_KEY: apiKey, OWNMIND_API_URL: apiUrl } });
      } else {
        // An empty first argument makes install.sh take the key from OWNMIND_INSTALL_KEY.
        await execFile('bash', [path.join(ownmindDir, 'install.sh'), '', apiUrl],
          { cwd: ownmindDir, timeout: INSTALL_TIMEOUT_MS, maxBuffer: OUTPUT_LIMIT, env: installEnv });
      }
    } catch (e) {
      return fail('reconfigure', e, { to });
    }
    try { fileSystem.unlinkSync(reconfigurePendingFile); } catch { /* already gone */ }
    return null;
  };

  const readVersion = () => {
    try {
      return JSON.parse(fileSystem.readFileSync(path.join(ownmindDir, 'package.json'), 'utf8')).version || null;
    } catch { return null; }
  };

  const applied = (to) => {
    logEvent('update_applied', { mode: 'archive', from, to });
    return result(APPLIED, { to, version: readVersion() });
  };

  // A swap that stopped part-way: resume it from the journal, without a download.
  if (fileSystem.existsSync(journalFile)) {
    let journal = null;
    try {
      journal = JSON.parse(fileSystem.readFileSync(journalFile, 'utf8'));
      if (!Array.isArray(journal.entries) || !Array.isArray(journal.done)) journal = null;
    } catch { journal = null; }
    if (journal) {
      logEvent('update_swap_resume', { mode: 'archive', from, to: journal.to, done: journal.done.length, of: journal.entries.length });
      ping();
      const stopped = runJournal(journal);
      if (stopped) return stopped;
      const reconfigured = await runInstaller(journal.to);
      return reconfigured || applied(journal.to);
    }
    // An unreadable journal: whether any entry moved cannot be told, so nothing is undone.
    return fail('journal_unreadable', new Error(`${SWAP_JOURNAL} cannot be read`));
  }

  if (!apiUrl || !apiKey) return result(SKIPPED, { reason: 'no_credentials' });

  logEvent('update_check', { mode: 'archive', from });
  let to;
  try {
    to = await serverRelease({ apiUrl, apiKey, fetch });
  } catch (e) {
    return fail('version_check', e);
  }

  // Same release (or the server is behind this machine): nothing to download. An installer
  // run that failed after an earlier swap is retried here.
  if (compareReleases(to, from) <= 0) {
    if (fileSystem.existsSync(reconfigurePendingFile)) {
      const reconfigured = await runInstaller(from);
      if (reconfigured) return reconfigured;
      logEvent('update_applied', { mode: 'archive', from, to: from, step: 'reconfigure_retry' });
      return result(APPLIED, { to: from, version: readVersion() });
    }
    logEvent('update_clean', { mode: 'archive', from, server: to });
    return result(CLEAN, { to: from });
  }

  // 2. Stage the release in .next. A .next without a journal is an earlier attempt's leftover.
  cleanStaging();
  try {
    fileSystem.mkdirSync(nextDir, { recursive: true });
    const url = `${String(apiUrl).replace(/\/+$/, '')}/api/install/archive${isWindows ? '?format=zip' : ''}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      const err = new Error(`server answered ${res.status}`);
      err.code = `http_${res.status}`;
      throw err;
    }
    fileSystem.writeFileSync(downloadFile, Buffer.from(await res.arrayBuffer()));
  } catch (e) {
    cleanStaging();
    return fail('download', e, { to });
  }
  ping();

  try {
    if (isWindows) {
      // Expand-Archive is in every Windows PowerShell 5.1; the paths travel in the environment
      // so no quoting layer can mangle them.
      await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "$ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath $env:OWNMIND_ARCHIVE -DestinationPath $env:OWNMIND_ARCHIVE_DEST -Force"],
      { timeout: UNPACK_TIMEOUT_MS, windowsHide: true,
        env: { ...childEnv, OWNMIND_ARCHIVE: downloadFile, OWNMIND_ARCHIVE_DEST: nextDir } });
    } else {
      await execFile('tar', ['-xzf', downloadFile, '-C', nextDir], { timeout: UNPACK_TIMEOUT_MS });
    }
    fileSystem.rmSync(downloadFile, { force: true });
    if (!isCompleteTree(fileSystem, nextDir, platform)) {
      const err = new Error('the archive is missing .release or the installer');
      err.code = 'incomplete_archive';
      throw err;
    }
    to = readRelease(nextDir, fileSystem) || to;
  } catch (e) {
    cleanStaging();
    return fail('unpack', e, { to });
  }

  // Dependencies, all inside .next. The live mcp/node_modules seeds the staged one (a copy; the
  // live tree is not touched) so npm only fetches what changed.
  const specs = (() => {
    try { return rootDependencySpecs(fileSystem.readFileSync(path.join(nextDir, 'scripts', 'update.sh'), 'utf8')); } catch { return []; }
  })();
  try {
    const seeds = [path.join('mcp', 'node_modules'), ...(specs.length > 0 ? ['node_modules'] : [])];
    for (const rel of seeds) {
      const seed = path.join(ownmindDir, rel);
      if (fileSystem.existsSync(seed) && !fileSystem.existsSync(path.join(nextDir, rel))) {
        copyEntry(fileSystem, seed, path.join(nextDir, rel));
      }
    }
  } catch (e) {
    cleanStaging();
    return fail('seed', e, { to });
  }

  try {
    // --ignore-scripts: as in shared/auto-update.js, no dependency needs an install script and
    // a dependency that turned malicious most often strikes through one.
    await npm(['install', '-q', '--ignore-scripts'], path.join(nextDir, 'mcp'));
  } catch (e) {
    cleanStaging();
    return fail('npm', e, { to });
  }
  ping();

  // The root dependencies scripts/update.sh installs (js-yaml for the conditional skill sync,
  // node-machine-id): a git install gets them from its daily sync. Not fatal there, not here.
  if (specs.length > 0) {
    try {
      await npm(['install', ...specs, '--no-save', '--ignore-scripts', '--silent', '--no-audit', '--no-fund'], nextDir);
    } catch (e) {
      logEvent('update_root_deps_failed', { mode: 'archive', to, error: errText(e) });
    }
    ping();
  }

  // 3. The code entries; a collision with runtime state stops here, before any rename.
  let entries;
  try {
    entries = codeEntries(fileSystem, nextDir);
  } catch (e) {
    cleanStaging();
    return fail(e.code === 'state_collision' ? 'state_collision' : 'stage', e, { to });
  }

  // 4. Swap. .prev is the previous release's code; it never holds runtime/ (removeTree is
  // careful anyway).
  try {
    removeTree(fileSystem, prevDir);
    fileSystem.mkdirSync(prevDir, { recursive: true });
    writeJournal({ version: 1, from, to, at: now().toISOString(), entries, done: [] });
  } catch (e) {
    cleanStaging();
    try { fileSystem.unlinkSync(journalFile); } catch { /* not written */ }
    return fail('swap_prepare', e, { to });
  }
  ping();
  const stopped = runJournal({ version: 1, from, to, entries, done: [] });
  if (stopped) return stopped;

  // 5. Host configuration from the new code.
  const reconfigured = await runInstaller(to);
  return reconfigured || applied(to);
}
