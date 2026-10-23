/**
 * shared/archive-update.js — updates for a machine that was installed without git.
 *
 * bootstrap.sh / bootstrap.ps1 install OwnMind from a release archive when the machine has no
 * usable git: ~/.ownmind then holds a `.release` file (vX.Y.Z, or `main` after a GitHub
 * fallback without tags) and no `.git`. Every git-based update path skips such a directory, so
 * without this file those machines would stay on the release they were installed with.
 *
 * The update, in order:
 *
 *   1. ask the server which release it ships (HEAD /api/install/archive, header X-OwnMind-Release);
 *   2. download that archive next to the live tree (`<dir>.next.partial`), unpack, check it has
 *      `.release` and the installer, rename it to `<dir>.next`;
 *   3. carry over everything the client wrote at runtime (key files, caches, logs, the private
 *      Node runtime, opt-out markers...) and install the dependencies there;
 *   4. swap: `<dir>` -> `<dir>.prev`, `<dir>.next` -> `<dir>`;
 *   5. re-run the installer from the new tree to rewrite the host configuration.
 *
 * Nothing touches the live tree before step 4. A failure in 1-3 removes `.next*` and leaves
 * the machine exactly as it was. On Windows the rename in step 4 fails while a process holds a
 * file inside the tree (a running MCP server); that writes `<dir>/.swap-pending`, and a later
 * run that finds it with a complete `.next` only retries the swap.
 *
 * `<dir>/runtime/current` is a symlink (macOS) or a directory junction (Windows) to the private
 * Node. Every recursive copy and delete here handles that link itself, so the target is neither
 * duplicated nor deleted through it.
 *
 * Everything is injected (process runner, fetch, file system, clock, logger), as in
 * shared/auto-update.js, so the interesting half is testable without a server or a network.
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

/** Marker files this module writes inside the live tree. */
export const SWAP_PENDING = '.swap-pending';
export const RECONFIGURE_PENDING = '.reconfigure-pending';

/**
 * What the client writes under ~/.ownmind at runtime, and so must survive a swap to a tree
 * unpacked from an archive. Found by reading install.sh/.ps1, hooks/, mcp/, shared/ and
 * scripts/ for paths written under the OwnMind directory:
 *
 *   credentials         key file (scripts/install-helpers/ensure-key-file.cjs, secure-key-files.cjs)
 *   cache/ state/       enforcement cache, init cache, session state (hooks/)
 *   logs/ reports/      hook and update logs, the self-check upload spool, touch reports
 *   runtime/            the private Node (handled by copyRuntime: runtime/current is a link)
 *   git-hooks/          the git hook wrappers, and any hook of the user's own that install.sh kept
 *   bin/                run-scanner.sh, which the launchd/systemd units point at
 *   mods/               not listed: it ships in the archive; install.sh re-links it
 *   judge.json          the judge model choice
 *   queue.jsonl         the MCP's offline queue (mcp/offline.js)
 *
 * plus every top-level dotfile the new tree does not have: .node-path, .no-usage-scanner,
 * .no-key-file, .no-session-hook, .no-monitor-mod, .no-touch-report, .no-self-check-upload,
 * .git-bash-path, .session-hook-installed, .last-update-check, .last-mcp-update-check,
 * .last-usage-roundtrip and .update-lock (so the lock this run holds is held in the new tree
 * too, and released there). A dotfile is picked up by that rule without being named here.
 */
export const PRESERVED_ENTRIES = [
  'credentials', 'cache', 'state', 'logs', 'reports', 'git-hooks', 'bin', 'judge.json', 'queue.jsonl',
];
/** Top-level dotfiles never carried over: they describe this tree, not the machine. */
const NOT_CARRIED = new Set(['.git', '.release', SWAP_PENDING, RECONFIGURE_PENDING]);
const notCarriedDotfile = (name) =>
  NOT_CARRIED.has(name) || name.startsWith('.update-lock.') || name.endsWith('.partial');

/** Seeded from the old tree so `npm install` only fetches what changed (and works on a slow network). */
const SEEDED_DEPENDENCIES = [path.join('mcp', 'node_modules'), 'node_modules'];

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
 * Delete a tree that may contain runtime/current, without deleting the Node it points to.
 * Removing the link first means no recursive delete ever meets it, whatever the platform's
 * rules for following links are.
 */
export function removeTree(fileSystem, dir) {
  if (!fileSystem.existsSync(dir) && !isLink(fileSystem, dir)) return;
  if (isLink(fileSystem, dir)) { removeLink(fileSystem, dir); return; }
  const current = path.join(dir, 'runtime', 'current');
  if (isLink(fileSystem, current)) removeLink(fileSystem, current);
  fileSystem.rmSync(dir, { recursive: true, force: true });
}

/** Recursive copy that copies links as links (relative targets stay relative). */
function copyEntry(fileSystem, from, to) {
  fileSystem.cpSync(from, to, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
    // A copy-on-write clone where the file system has one (APFS): the Node runtime is ~100 MB.
    mode: fs.constants.COPYFILE_FICLONE,
  });
}

/**
 * Copy runtime/ with runtime/current excluded from the recursive copy, then re-create the link
 * with the same target. On Windows the junction's target is absolute
 * (…\.ownmind\runtime\node-vX), which after the swap names the copy in the new tree.
 */
export function copyRuntime(fileSystem, fromDir, toDir, platform = process.platform) {
  if (!fileSystem.existsSync(fromDir)) return;
  fileSystem.mkdirSync(toDir, { recursive: true });
  for (const name of fileSystem.readdirSync(fromDir)) {
    if (name === 'current' || name.endsWith('.partial')) continue;
    copyEntry(fileSystem, path.join(fromDir, name), path.join(toDir, name));
  }
  const from = path.join(fromDir, 'current');
  const to = path.join(toDir, 'current');
  if (isLink(fileSystem, from)) {
    const target = fileSystem.readlinkSync(from);
    if (isLink(fileSystem, to) || fileSystem.existsSync(to)) removeTree(fileSystem, to);
    fileSystem.symlinkSync(target, to, platform === 'win32' ? 'junction' : undefined);
  } else if (fileSystem.existsSync(from)) {
    // A real directory named current (an older layout): copied as it is.
    copyEntry(fileSystem, from, to);
  }
}

/** Carry the runtime state of `oldDir` into `newDir` (see PRESERVED_ENTRIES). */
export function carryOverState(fileSystem, oldDir, newDir, { platform = process.platform, includeRuntime = true } = {}) {
  const carried = [];
  for (const name of PRESERVED_ENTRIES) {
    const from = path.join(oldDir, name);
    if (!fileSystem.existsSync(from)) continue;
    copyEntry(fileSystem, from, path.join(newDir, name));
    carried.push(name);
  }
  for (const name of fileSystem.readdirSync(oldDir)) {
    if (!name.startsWith('.') || notCarriedDotfile(name)) continue;
    const to = path.join(newDir, name);
    // A dotfile the release ships (.gitignore, .editorconfig...) is the release's to own.
    if (fileSystem.existsSync(to)) continue;
    copyEntry(fileSystem, path.join(oldDir, name), to);
    carried.push(name);
  }
  if (includeRuntime && fileSystem.existsSync(path.join(oldDir, 'runtime'))) {
    copyRuntime(fileSystem, path.join(oldDir, 'runtime'), path.join(newDir, 'runtime'), platform);
    carried.push('runtime');
  }
  return carried;
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
  reconfigure = true,
}) {
  const isWindows = platform === 'win32';
  const from = readRelease(ownmindDir, fileSystem);
  const nextDir = `${ownmindDir}.next`;
  const partialDir = `${nextDir}.partial`;
  const prevDir = `${ownmindDir}.prev`;
  const swapPendingFile = path.join(ownmindDir, SWAP_PENDING);
  const reconfigurePendingFile = path.join(ownmindDir, RECONFIGURE_PENDING);
  const nodeDir = nodeBin ? path.dirname(nodeBin) : '';
  const childEnv = withDirOnPath(env, nodeDir, isWindows);

  const result = (outcome, extra = {}) => ({ outcome, from, to: null, ...extra });
  const fail = (step, err, extra = {}) => {
    logEvent('update_failed', { mode: 'archive', step, from, error: errText(err) });
    return result(FAILED, { reason: step, ...extra });
  };
  const cleanNext = () => {
    for (const d of [partialDir, nextDir]) {
      try { removeTree(fileSystem, d); } catch (e) { logEvent('update_cleanup_failed', { mode: 'archive', dir: path.basename(d), error: errText(e) }); }
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

  /** Swap the trees. Returns null on success, or the result to hand back. */
  const swap = (to) => {
    try { removeTree(fileSystem, prevDir); } catch (e) { return fail('remove_prev', e, { to }); }
    try {
      fileSystem.renameSync(ownmindDir, prevDir);
    } catch (e) {
      if (swapBlocked(e)) {
        // The live tree is untouched; the prepared one waits beside it.
        try { fileSystem.writeFileSync(swapPendingFile, `${nextDir}\n${now().toISOString()}\n`); } catch { /* best effort */ }
        logEvent('update_swap_pending', { mode: 'archive', from, to, error: errText(e) });
        return result(FAILED, { reason: 'swap_pending', to });
      }
      cleanNext();
      return fail('swap', e, { to });
    }
    try {
      fileSystem.renameSync(nextDir, ownmindDir);
    } catch (e) {
      // Put the old tree back where it was.
      try { fileSystem.renameSync(prevDir, ownmindDir); } catch (e2) {
        logEvent('update_failed', { mode: 'archive', step: 'swap_rollback', from, to, error: errText(e2) });
        return result(FAILED, { reason: 'swap_rollback', to });
      }
      cleanNext();
      return fail('swap', e, { to });
    }
    // A rename keeps the old tree's modification time; the upgraders' 7-day sweep of .prev
    // should count from the swap.
    try { const t = now(); fileSystem.utimesSync(prevDir, t, t); } catch { /* best effort */ }
    return null;
  };

  /** Re-run the installer from the (new) live tree. Returns null on success. */
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

  // A swap that was blocked earlier: the prepared tree is waiting, only the swap is retried.
  if (fileSystem.existsSync(swapPendingFile)) {
    let named = '';
    try { named = fileSystem.readFileSync(swapPendingFile, 'utf8').split(/\r?\n/)[0].trim(); } catch { /* unreadable */ }
    if (path.resolve(named || nextDir) === path.resolve(nextDir) && isCompleteTree(fileSystem, nextDir, platform)) {
      const to = readRelease(nextDir, fileSystem);
      logEvent('update_swap_retry', { mode: 'archive', from, to });
      // Logs, caches and markers written since the tree was prepared are carried again.
      try { carryOverState(fileSystem, ownmindDir, nextDir, { platform, includeRuntime: false }); } catch (e) { return fail('carry_over', e, { to }); }
      const swapped = swap(to);
      if (swapped) return swapped;
      const reconfigured = await runInstaller(to);
      return reconfigured || applied(to);
    }
    try { fileSystem.unlinkSync(swapPendingFile); } catch { /* already gone */ }
    cleanNext();
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

  // 2. Download and unpack next to the live tree.
  cleanNext();
  const archiveFile = path.join(partialDir, isWindows ? 'archive.zip' : 'archive.tar.gz');
  try {
    fileSystem.mkdirSync(partialDir, { recursive: true });
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
    fileSystem.writeFileSync(archiveFile, Buffer.from(await res.arrayBuffer()));
  } catch (e) {
    cleanNext();
    return fail('download', e, { to });
  }

  try {
    if (isWindows) {
      // Expand-Archive is in every Windows PowerShell 5.1; the paths travel in the environment
      // so no quoting layer can mangle them.
      await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "$ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath $env:OWNMIND_ARCHIVE -DestinationPath $env:OWNMIND_ARCHIVE_DEST -Force"],
      { timeout: UNPACK_TIMEOUT_MS, windowsHide: true,
        env: { ...childEnv, OWNMIND_ARCHIVE: archiveFile, OWNMIND_ARCHIVE_DEST: partialDir } });
    } else {
      await execFile('tar', ['-xzf', archiveFile, '-C', partialDir], { timeout: UNPACK_TIMEOUT_MS });
    }
    fileSystem.rmSync(archiveFile, { force: true });
    if (!isCompleteTree(fileSystem, partialDir, platform)) {
      const err = new Error('the archive is missing .release or the installer');
      err.code = 'incomplete_archive';
      throw err;
    }
    to = readRelease(partialDir, fileSystem) || to;
    fileSystem.renameSync(partialDir, nextDir);
  } catch (e) {
    cleanNext();
    return fail('unpack', e, { to });
  }

  // 3. Runtime state and dependencies, all inside .next.
  try {
    carryOverState(fileSystem, ownmindDir, nextDir, { platform });
    for (const rel of SEEDED_DEPENDENCIES) {
      const seed = path.join(ownmindDir, rel);
      if (fileSystem.existsSync(seed)) copyEntry(fileSystem, seed, path.join(nextDir, rel));
    }
  } catch (e) {
    cleanNext();
    return fail('carry_over', e, { to });
  }

  try {
    // --ignore-scripts: as in shared/auto-update.js, no dependency needs an install script and
    // a dependency that turned malicious most often strikes through one.
    await npm(['install', '-q', '--ignore-scripts'], path.join(nextDir, 'mcp'));
  } catch (e) {
    cleanNext();
    return fail('npm', e, { to });
  }

  // The root dependencies scripts/update.sh installs (js-yaml for the conditional skill sync,
  // node-machine-id): a git install gets them from its daily sync. Not fatal there, not here.
  let specs = [];
  try { specs = rootDependencySpecs(fileSystem.readFileSync(path.join(nextDir, 'scripts', 'update.sh'), 'utf8')); } catch { /* none */ }
  if (specs.length > 0) {
    try {
      await npm(['install', ...specs, '--no-save', '--ignore-scripts', '--silent', '--no-audit', '--no-fund'], nextDir);
    } catch (e) {
      logEvent('update_root_deps_failed', { mode: 'archive', to, error: errText(e) });
    }
  }

  // 4. Swap. 5. Host configuration from the new tree.
  const swapped = swap(to);
  if (swapped) return swapped;
  const reconfigured = await runInstaller(to);
  return reconfigured || applied(to);
}
