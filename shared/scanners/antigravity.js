/**
 * shared/scanners/antigravity.js — Tier 2 session_count (no token data).
 *
 * Antigravity is VSCode-based like Cursor and shares the state.vscdb layout,
 * so both reuse createVscodeAdapter. Only the DB path differs.
 *
 * v1.26.66 — the application writes to more than one directory name. Measured on a Mac
 * on 2026-08-05: `com.google.antigravity` under `Antigravity` held telemetry ending
 * 2026-05-18, while `com.google.antigravity-ide` under `Antigravity IDE` held telemetry
 * starting 2026-05-20 and running to that day. One stops where the other starts, which
 * is a migration rather than two products in parallel.
 *
 * The adapter was pointed at the abandoned side and had been for eleven weeks. Because
 * Tier 2 emits no token events by construction, its only possible symptom was "no new
 * day", which is also what every ordinary scan produces — so nothing looked wrong at
 * any layer. Both names are candidates now, and the freshest wins.
 */

import path from 'path';
import os from 'os';
import { createVscodeAdapter } from './vscode-telemetry.js';
import { geminiConversationDirs, probeConversations } from './gemini-conversations.js';

const TOOL = 'antigravity';

/**
 * Directory names Antigravity has used, oldest first. A future rename is one entry
 * here; nothing else needs to change.
 */
const DIR_NAMES = ['Antigravity', 'Antigravity IDE'];

/** Where a VSCode-based editor keeps per-user storage, by platform. */
const USER_DATA_PREFIX = {
  darwin: 'Library/Application Support',
  linux: '.config',
  win32: 'AppData/Roaming'
};

/**
 * Every state.vscdb Antigravity might be writing to on this platform.
 *
 * @param {string} [platform] - process.platform value
 * @param {string} [homeDir]
 * @returns {string[]}
 */
export function antigravityDbCandidates(
  platform = process.platform,
  homeDir = os.homedir()
) {
  // Unknown platforms fall back to the darwin layout, which is what the single-path
  // version did before this change.
  const prefix = USER_DATA_PREFIX[platform] ?? USER_DATA_PREFIX.darwin;
  return DIR_NAMES.map((name) =>
    path.join(homeDir, prefix, name, 'User', 'globalStorage', 'state.vscdb'));
}

export function createAntigravityAdapter({
  dbPath, dbPaths, homeDir, conversationDirs, extraDateSources, ...rest
} = {}) {
  // v1.26.68 — state.vscdb only ever covers the editor. The agent manager and the CLI
  // are not VSCode applications, so their days can only come from their conversation
  // stores. This source is added for every construction path, including the explicit
  // one: `dbPath` asserts which database to read, not that the database is the only
  // thing worth reading.
  const sources = extraDateSources ?? [
    // Returns { date, looked } rather than a bare date. A conversation store that
    // exists and is empty is an installed tool with nothing recorded yet; without
    // `looked` that is indistinguishable from a machine where Antigravity has never
    // been, and the collector would tell an operator to install what is installed.
    () => probeConversations({
      dirs: conversationDirs ?? geminiConversationDirs(homeDir),
      logger: rest.logger ?? null
    })
  ];

  // An explicit dbPath stays an explicit dbPath: callers and tests that name one file
  // get exactly that file, unfiltered.
  if (dbPath != null) {
    return createVscodeAdapter({ tool: TOOL, dbPath, extraDateSources: sources, ...rest });
  }
  return createVscodeAdapter({
    tool: TOOL,
    dbPaths: dbPaths ?? antigravityDbCandidates(),
    extraDateSources: sources,
    ...rest
  });
}
