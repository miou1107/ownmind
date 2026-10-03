import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Which local files ownmind_upload_standard may read.
 *
 * The tool takes a path from the AI and publishes the file to the whole team as a team
 * standard. It used to read whatever it was given — `~/.ssh/id_rsa`, `~/.claude.json` with the
 * user's key in it, a `.env` — so an AI steered by a web page or a README it had just read
 * could publish a credential to every member with two tool calls. Security review 2026-10-03,
 * item 10. The server now scans the content too (src/utils/standard-upload-check.js); this is
 * the half that stops the file being read at all.
 *
 *   - Markdown only, judged on the real file after symlinks: the tool's own contract says
 *     "a local Markdown standard file", and every credential file has another extension.
 *   - A regular file, at most MAX_BYTES. A standard is prose; a multi-megabyte file is not one.
 *   - Not inside a folder that exists to hold credentials, whatever the extension.
 */

export const MAX_BYTES = 512 * 1024;
const MARKDOWN = new Set(['.md', '.markdown']);
const CREDENTIAL_DIRS = ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', path.join('.config', 'gcloud')];

/**
 * @param {string} filePath
 * @param {{ home?: string }} [opts]
 * @returns {{ ok: true, realPath: string, size: number, content: string } | { ok: false, error: string }}
 */
export function checkStandardFile(filePath, { home = os.homedir() } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    return { ok: false, error: 'file_path must be an absolute path to a Markdown file' };
  }
  // A network share is somebody else's machine, and on Windows `\\localhost\c$\…` is this one
  // under a name the folder check below does not recognise. A standard lives on local disk.
  if (/^[\\/]{2}/.test(filePath)) return { ok: false, error: `Network paths are not accepted: ${filePath}` };
  let realPath;
  try {
    // .native: on Windows it expands 8.3 short names (`SSH~1` back to `.ssh`), which the
    // JavaScript implementation leaves as given — and the folder check would not recognise.
    realPath = (fs.realpathSync.native || fs.realpathSync)(filePath);
  } catch {
    return { ok: false, error: `File not found: ${filePath}` };
  }
  if (/^[\\/]{2}/.test(realPath)) return { ok: false, error: `Network paths are not accepted: ${realPath}` };
  for (const p of [filePath, realPath]) {
    if (!MARKDOWN.has(path.extname(p).toLowerCase())) {
      return { ok: false, error: `Only Markdown files (.md, .markdown) can be uploaded as a team standard: ${p}` };
    }
  }
  let realHome = home;
  try { realHome = (fs.realpathSync.native || fs.realpathSync)(home); } catch { /* keep as given */ }
  const lower = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  for (const dir of CREDENTIAL_DIRS) {
    for (const base of new Set([home, realHome])) {
      const rel = path.relative(lower(path.join(base, dir)), lower(realPath));
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
        return { ok: false, error: `Refusing to read from ${path.join(base, dir)}: that folder holds credentials` };
      }
    }
  }

  // One open for the checks and the read, so the file cannot be swapped in between, and the
  // size is enforced on what is actually read rather than on what stat said a moment earlier.
  let fd;
  try {
    fd = fs.openSync(realPath, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { ok: false, error: `Not a regular file: ${realPath}` };
    // A hard link is a second name for the same file, and there is nothing to resolve: a
    // `notes.md` hard-linked to `~/.ssh/id_rsa` passes every check above. Measured on Windows,
    // where an ordinary user can make one. A real standard has no reason to be one.
    if (stat.nlink > 1) return { ok: false, error: `Refusing a file with more than one name (a hard link): ${realPath}` };
    if (stat.size > MAX_BYTES) {
      return { ok: false, error: `File is ${stat.size} bytes; a team standard may be at most ${MAX_BYTES}` };
    }
    const buf = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    for (let n; size < buf.length && (n = fs.readSync(fd, buf, size, buf.length - size, null)) > 0;) size += n;
    if (size > MAX_BYTES) return { ok: false, error: `File is larger than ${MAX_BYTES} bytes` };
    return { ok: true, realPath, size, content: buf.subarray(0, size).toString('utf8') };
  } catch (err) {
    return { ok: false, error: `Could not read ${realPath}: ${err.code || err.message}` };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
