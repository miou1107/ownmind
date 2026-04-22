/**
 * shared/scanners/antigravity.js — Tier 2 session_count（無 token）
 *
 * Antigravity 與 Cursor 同樣 VSCode-based，state.vscdb 結構一致，共用
 * createVscodeAdapter。只是 DB 路徑不同。
 */

import path from 'path';
import os from 'os';
import { createVscodeAdapter } from './vscode-telemetry.js';

const TOOL = 'antigravity';

const DEFAULT_DB_PATHS = {
  darwin: path.join(os.homedir(),
    'Library/Application Support/Antigravity/User/globalStorage/state.vscdb'),
  linux: path.join(os.homedir(), '.config/Antigravity/User/globalStorage/state.vscdb'),
  win32: path.join(os.homedir(), 'AppData/Roaming/Antigravity/User/globalStorage/state.vscdb')
};

export function createAntigravityAdapter({
  dbPath = DEFAULT_DB_PATHS[process.platform] ?? DEFAULT_DB_PATHS.darwin,
  ...rest
} = {}) {
  return createVscodeAdapter({ tool: TOOL, dbPath, ...rest });
}
