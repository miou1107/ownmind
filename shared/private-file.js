import fs from 'node:fs';
import path from 'node:path';

/**
 * Files under ~/.ownmind that hold memory text — the offline caches and the queue of writes
 * waiting for the network — are readable by the owner only.
 *
 * `mode` on writeFileSync applies only when the file is created, so a cache written by an
 * older version keeps the umask's 0644 for ever. The chmod afterwards closes that, and costs
 * nothing once the mode is already right. Windows has no such bits; there both calls are
 * no-ops in effect and the folder's own permissions are what count.
 */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function ensurePrivateDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
}

function tighten(file) {
  if (process.platform === 'win32') return;
  try { fs.chmodSync(file, FILE_MODE); } catch { /* best effort: the write itself succeeded */ }
}

export function writePrivateFile(file, data) {
  ensurePrivateDir(path.dirname(file));
  fs.writeFileSync(file, data, { mode: FILE_MODE });
  tighten(file);
}

export function appendPrivateFile(file, data) {
  ensurePrivateDir(path.dirname(file));
  fs.appendFileSync(file, data, { mode: FILE_MODE });
  tighten(file);
}
