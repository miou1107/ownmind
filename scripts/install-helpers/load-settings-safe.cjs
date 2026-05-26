'use strict';

/**
 * Safely read and parse a JSON config file. Intended for the `node -e` blocks inside
 * update.sh / update.ps1.
 *
 * Behavior:
 *   - File missing → return fallback (caller can safely create a new file).
 *   - File unreadable (permissions) → console.error warning + process.exit(0).
 *   - JSON malformed → console.error warning + process.exit(0) (no return; the caller's
 *     subsequent write block never runs).
 *
 * Why exit(0) on corruption:
 *   The old version used try { JSON.parse } catch {} and swallowed errors; the caller
 *   then continued with an empty {} and wrote it back, blowing away the user's damaged-but-
 *   real config. exit(0) ensures the caller's later writeFile never runs, so the original
 *   file is preserved. We use exit code 0 because update.sh must not crash entirely just
 *   because one hook block is malformed — it should continue to the next block.
 */

const fs = require('fs');

function loadOrSkip(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    console.error('[ownmind] WARN: cannot read ' + filePath + ' (' + (e.code || e.message) + '); skipping this block');
    process.exit(0);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error('[ownmind] WARN: ' + filePath + ' is malformed JSON; skipping this block to avoid overwriting your data (' + e.message + ')');
    process.exit(0);
  }

  // Prevent later `s.hooks = ...` from throwing TypeError on null / number / string / array.
  // The config file should be a JSON object — if not, skip.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error('[ownmind] WARN: ' + filePath + ' is not a JSON object (' + (Array.isArray(parsed) ? 'array' : typeof parsed) + '); skipping this block to avoid overwriting your data');
    process.exit(0);
  }
  return parsed;
}

module.exports = { loadOrSkip };
