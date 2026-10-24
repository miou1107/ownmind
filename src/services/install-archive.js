import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { writeZipFromDir } from './zip-writer.js';

/**
 * The release archive: a .tar.gz of the server's own checkout, so a machine without git can
 * install OwnMind from the server alone. Windows asks for the same tree as a .zip
 * (`format: 'zip'`), because Expand-Archive reads nothing else.
 *
 * What is left out is what the install never reads: dependencies (the installer runs
 * `npm install` itself), version-control data, tests, migrations and the server-only code.
 * `src/utils/` stays, as in a git clone: the MCP server and the sync hook import from it at
 * startup, so an install without it dies with ERR_MODULE_NOT_FOUND. Developer-tool folders
 * are left out as well, so packing a working copy does not drag a worktree's session notes along.
 */

// Excluded when the path relative to the repo root equals one of these.
const EXCLUDED_PATHS = new Set([
  '.git', 'tests', 'db', 'client/src',
  '.claude', '.superpowers', '.ownmind',
]);
// Excluded at any depth.
const EXCLUDED_NAMES = new Set(['node_modules', '.git']);
// Excluded at the top level: the names an installed client keeps its runtime state under
// (shared/archive-update.js, STATE_ENTRIES). A server checkout that happens to hold one must not
// ship it, and the client's archive update refuses a release that carries one.
const STATE_NAMES = new Set([
  'runtime', 'cache', 'state', 'logs', 'reports', 'credentials', 'git-hooks', 'bin', 'judge.json', 'queue.jsonl',
  '.node-path', '.swap-pending', '.swap-journal.json', '.prev', '.next', '.next.download', '.reconfigure-pending',
  '.git-bash-path', '.session-hook-installed',
]);
const isStateName = (name) => STATE_NAMES.has(name) || /^\.(no|last)-/.test(name) || name.startsWith('.update-lock');

const FORMATS = { 'tar.gz': 'tar.gz', zip: 'zip' };

const built = new Map(); // `${repoRoot}\0${version}\0${format}` -> Promise<{ path, version, sha256 }>

function isExcluded(rel) {
  if (EXCLUDED_PATHS.has(rel)) return true;
  if (!rel.includes('/') && isStateName(rel)) return true;
  // Under src/ only utils/ is kept (src/ itself stays so that utils/ has a parent).
  if (rel.startsWith('src/') && rel !== 'src/utils' && !rel.startsWith('src/utils/')) return true;
  return rel.split('/').some((part) => EXCLUDED_NAMES.has(part) || isSecretName(part));
}

// Secrets a server checkout can hold (the Docker image already leaves .env out through
// .dockerignore; a server started from a working copy does not). Never shipped to a client.
function isSecretName(name) {
  return name === '.env' || (name.startsWith('.env.') && name !== '.env.example') || name.endsWith('.pem');
}

function tarCreate(archivePath, cwd, entries) {
  return new Promise((resolve, reject) => {
    execFile('tar', ['-czf', archivePath, '-C', cwd, ...entries], { maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) => {
      if (err) reject(new Error(`tar failed: ${stderr || err.message}`));
      else resolve();
    });
  });
}

function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => hash.update(c)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

/**
 * Copies `from` into `to`, keeping what isExcluded lets through. Each relative name is built from
 * the directory entries themselves rather than from full paths: with fs.cp's filter comparing
 * full paths, the Windows runner excluded nothing and packed db/, tests/ and runtime state.
 * Symbolic links are left out; the release is plain files, and a link could point outside the tree.
 */
async function stageTree(from, to, prefix = '') {
  await fsp.mkdir(to, { recursive: true });
  for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (isExcluded(rel)) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) await stageTree(src, dest, rel);
    else if (entry.isFile()) await fsp.copyFile(src, dest);
  }
}

async function build({ repoRoot, version, format }) {
  const stage = await fsp.mkdtemp(path.join(os.tmpdir(), 'ownmind-install-stage-'));
  // The source folder is part of the name: two servers (or two test files) on one machine
  // packing the same version from different trees must not write, and serve, one another's file.
  const tree = crypto.createHash('sha256').update(path.resolve(repoRoot)).digest('hex').slice(0, 12);
  const target = path.join(os.tmpdir(), `ownmind-install-${version}-${tree}.${format}`);
  const partial = `${target}.${process.pid}.partial`;
  try {
    await stageTree(repoRoot, stage);
    await fsp.writeFile(path.join(stage, '.release'), `${version}\n`);
    if (format === 'zip') {
      await writeZipFromDir({ dir: stage, out: partial });
    } else {
      // Name the top-level entries instead of packing '.', so members read `install.sh`, not `./install.sh`.
      const entries = (await fsp.readdir(stage)).sort();
      await tarCreate(partial, stage, entries);
    }
    await fsp.rename(partial, target);
  } finally {
    await fsp.rm(stage, { recursive: true, force: true });
    await fsp.rm(partial, { force: true });
  }
  return { path: target, version, sha256: await sha256Of(target) };
}

/**
 * Build the archive once per process, version and format; later calls get the same file.
 *
 * @param {{ repoRoot: string, version: string, format?: 'tar.gz'|'zip' }} opts version as written to `.release`, e.g. "v1.33.1"
 * @returns {Promise<{ path: string, version: string, sha256: string }>}
 */
export function buildInstallArchive({ repoRoot, version, format = 'tar.gz' }) {
  if (!Object.hasOwn(FORMATS, format)) throw new Error(`unsupported archive format: ${format}`);
  const key = `${repoRoot}\0${version}\0${format}`;
  if (!built.has(key)) {
    const p = build({ repoRoot, version, format });
    built.set(key, p);
    // A failed build must not be remembered, or the next request would replay the failure.
    p.catch(() => built.delete(key));
  }
  return built.get(key);
}
