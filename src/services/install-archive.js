import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

/**
 * The release archive: a .tar.gz of the server's own checkout, so a machine without git can
 * install OwnMind from the server alone.
 *
 * What is left out is what the install never reads: dependencies (the installer runs
 * `npm install` itself), version-control data, tests, and the server-only code and
 * migrations. Developer-tool folders are left out as well, so packing a working copy does
 * not drag a worktree's session notes along.
 */

// Excluded when the path relative to the repo root equals one of these.
const EXCLUDED_PATHS = new Set([
  '.git', 'tests', 'db', 'src', 'client/src',
  '.claude', '.superpowers', '.ownmind',
]);
// Excluded at any depth.
const EXCLUDED_NAMES = new Set(['node_modules', '.git']);

const built = new Map(); // `${repoRoot}\0${version}` -> Promise<{ path, version, sha256 }>

function isExcluded(rel) {
  if (EXCLUDED_PATHS.has(rel)) return true;
  return rel.split('/').some((part) => EXCLUDED_NAMES.has(part));
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

async function build({ repoRoot, version }) {
  const stage = await fsp.mkdtemp(path.join(os.tmpdir(), 'ownmind-install-stage-'));
  const target = path.join(os.tmpdir(), `ownmind-install-${version}.tar.gz`);
  const partial = `${target}.${process.pid}.partial`;
  try {
    await fsp.cp(repoRoot, stage, {
      recursive: true,
      filter: (src) => {
        const rel = path.relative(repoRoot, src).split(path.sep).join('/');
        return rel === '' || !isExcluded(rel);
      },
    });
    await fsp.writeFile(path.join(stage, '.release'), `${version}\n`);
    // Name the top-level entries instead of packing '.', so members read `install.sh`, not `./install.sh`.
    const entries = (await fsp.readdir(stage)).sort();
    await tarCreate(partial, stage, entries);
    await fsp.rename(partial, target);
  } finally {
    await fsp.rm(stage, { recursive: true, force: true });
    await fsp.rm(partial, { force: true });
  }
  return { path: target, version, sha256: await sha256Of(target) };
}

/**
 * Build the archive once per process and version; later calls get the same file.
 *
 * @param {{ repoRoot: string, version: string }} opts version as written to `.release`, e.g. "v1.33.1"
 * @returns {Promise<{ path: string, version: string, sha256: string }>}
 */
export function buildInstallArchive({ repoRoot, version }) {
  const key = `${repoRoot}\0${version}`;
  if (!built.has(key)) {
    const p = build({ repoRoot, version });
    built.set(key, p);
    // A failed build must not be remembered, or the next request would replay the failure.
    p.catch(() => built.delete(key));
  }
  return built.get(key);
}
