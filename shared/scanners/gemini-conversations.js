/**
 * shared/scanners/gemini-conversations.js — session dates for the Antigravity surfaces
 * that are not VSCode applications.
 *
 * v1.26.68. Antigravity ships as three surfaces sharing one account and one settings
 * tree: the agent manager (`Antigravity.app`), the editor (`Antigravity IDE.app`) and
 * the CLI (`agy`). Only the editor is a VSCode application, so only the editor writes
 * the `telemetry.currentSessionDate` key the collector reads. v1.26.66 fixed *which*
 * `state.vscdb` is read and made the editor visible; it could not reach the other two.
 *
 * All three write per-conversation files under `~/.gemini/<surface>/conversations/`.
 * Measured on a Mac on 2026-08-05: the manager's `state.vscdb` was frozen at
 * 2026-05-18 while its conversation store held eight later days, and the CLI held nine
 * days and has no telemetry of any kind.
 *
 * Two deliberate constraints:
 *
 *   - The files hold the user's conversations. This module calls `stat()` and never
 *     opens one. The collector's business is *when*, never *what*.
 *   - The surfaces are listed, not globbed. `~/.gemini/antigravity-backup/` is a dead
 *     copy left by the 2026-05-20 migration and holds 101 conversation files;
 *     `antigravity*` would match it.
 */

import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { FUTURE_TOLERANCE_MS } from './vscode-telemetry.js';

/** Antigravity surfaces that keep a conversation store, in no significant order. */
const SURFACES = ['antigravity', 'antigravity-ide', 'antigravity-cli'];

/**
 * Conversation directory of every known surface.
 *
 * `~/.gemini` is a home-directory tree on every platform, so unlike the `state.vscdb`
 * candidates there is no per-OS prefix to choose.
 *
 * @param {string} [homeDir]
 * @returns {string[]}
 */
export function geminiConversationDirs(homeDir = os.homedir()) {
  return SURFACES.map((s) => path.join(homeDir, '.gemini', s, 'conversations'));
}

/**
 * Newest conversation-file mtime across the given directories, or null.
 *
 * Extension is not consulted. The manager holds 13 `.db` and 100 `.pb`; the CLI's
 * newest entry is usually a `.db-wal`. The product has already changed conversation
 * format once, and a filter keyed on today's extensions would go quiet on the next
 * change in exactly the silent way the directory rename did.
 *
 * The directory's own mtime is not usable: it moves when a conversation is created,
 * not when an existing one is written to.
 *
 * @param {{dirs: string[], readdir?: Function, stat?: Function, logger?: object}} opts
 * @returns {Promise<Date|null>}
 */
export async function newestConversationMtime(opts = {}) {
  return (await probeConversations(opts)).date;
}

/**
 * The same read, plus how many conversation directories were actually there.
 *
 * v1.26.69. A date of null answers two different questions the same way: "this tool is
 * not on this machine" and "this tool is here and has no conversations yet". The caller
 * needs them apart, because one of them tells an operator to go and install something
 * that is already installed.
 *
 * @param {{dirs: string[], readdir?: Function, stat?: Function, logger?: object,
 *          notAfter?: number}} opts
 * @returns {Promise<{date: Date|null, looked: number}>}
 */
export async function probeConversations({
  dirs, readdir = fsp.readdir, stat = fsp.stat, logger = null,
  notAfter = Date.now() + FUTURE_TOLERANCE_MS
} = {}) {
  let newest = null;
  let looked = 0;

  for (const dir of dirs ?? []) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      // Only ENOENT means "this surface is not installed". Most machines have one of
      // the three, so warning about the absent two would fire on every healthy scan.
      // Anything else — a permission wall, an I/O error — is a question that could not
      // be answered, and staying silent about it is how a broken collector looks well.
      if (err?.code !== 'ENOENT') {
        logger?.warn?.(`[gemini-conversations] cannot list ${dir}: ${err.message}`);
      }
      continue;
    }
    // The directory was there and could be listed. That is the fact the caller needs,
    // whether or not it happens to hold anything yet.
    looked += 1;

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      let st;
      try {
        st = await stat(path.join(dir, entry.name));
      } catch {
        // A conversation deleted between readdir and stat is ordinary. One unreadable
        // entry must not cost the whole directory.
        continue;
      }
      // The ceiling is applied per file, here, because here the file can be named.
      // Taking the maximum first and judging it afterwards discards every believable
      // date sitting in the same directory as one bad one.
      if (st.mtime.getTime() > notAfter) {
        logger?.warn?.(
          `[gemini-conversations] ignoring future conversation mtime ` +
          `${st.mtime.toISOString()} from ${path.join(dir, entry.name)}; ` +
          `the clock that wrote it was wrong`
        );
        continue;
      }
      if (newest === null || st.mtime > newest) newest = st.mtime;
    }
  }

  return { date: newest, looked };
}
