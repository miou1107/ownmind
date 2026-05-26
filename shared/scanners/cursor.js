/**
 * shared/scanners/cursor.js — Tier 2 session_count (no token data).
 *
 * Reads Cursor's state.vscdb telemetry to infer "did the user open Cursor today",
 * then upserts one session_count record. The server's UNIQUE(user, tool, date)
 * constraint deduplicates.
 */

import path from 'path';
import os from 'os';
import { createVscodeAdapter } from './vscode-telemetry.js';

const TOOL = 'cursor';

const DEFAULT_DB_PATHS = {
  darwin: path.join(os.homedir(),
    'Library/Application Support/Cursor/User/globalStorage/state.vscdb'),
  linux: path.join(os.homedir(), '.config/Cursor/User/globalStorage/state.vscdb'),
  win32: path.join(os.homedir(), 'AppData/Roaming/Cursor/User/globalStorage/state.vscdb')
};

export function createCursorAdapter({
  dbPath = DEFAULT_DB_PATHS[process.platform] ?? DEFAULT_DB_PATHS.darwin,
  ...rest
} = {}) {
  return createVscodeAdapter({ tool: TOOL, dbPath, ...rest });
}
