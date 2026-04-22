/**
 * shared/scanners/cursor.js — Tier 2 session_count（無 token）
 *
 * 讀取 Cursor 的 state.vscdb telemetry 欄位推斷「今天有沒有用 Cursor」，
 * upsert 一筆 session_count record。server UNIQUE(user, tool, date) 擋重複。
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
