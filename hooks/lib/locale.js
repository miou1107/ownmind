// hooks/lib/locale.js — resolves which locale hook user notices should render in.
//
// Resolution order (first match wins):
//   1. OWNMIND_LOCALE_FORCE  — test-only seam, checked first so tests never touch real
//                              config; this is the same seam Task 1's stub already honored.
//   2. account preference    — `data.locale` in `<homeDir>/.ownmind/cache/memories.json`
//                              (the local cache conditional-sync.js writes), honored only
//                              when it is exactly 'zh'|'en'|'ja'. `data.locale` does not
//                              exist until a later task starts sending it, so absence — and
//                              any other malformed shape — must resolve like "no preference".
//   3. OS-detected locale    — the normalized `detected` field of
//                              `<homeDir>/.ownmind/state/locale.json`, written once per
//                              session by locale-provision.js at SessionStart. Normalization
//                              lives here, not there: a bad raw OS value must never be able
//                              to poison this always-sync, never-throws read path.
//   4. 'en'                  — final fallback.
//
// getLocale() is sync, total (never throws) and never spawns a subprocess or touches the
// network — OS detection is a SessionStart-only concern handled by locale-provision.js.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VALID_LOCALES = new Set(['zh', 'en', 'ja']);

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    // Missing file, unreadable file, or corrupt JSON — all read the same as "nothing here".
    return null;
  }
}

/**
 * Normalizes a raw OS locale string (e.g. "zh_TW", "en-US", "ja_JP.UTF-8") into one of our
 * three supported codes. Only ever applied to the detected value, never to a stored account
 * preference — an invalid preference is a deliberate-but-wrong choice and should be ignored
 * outright, not coerced into whatever this happens to map it to.
 */
function normalizeDetected(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^zh/i.test(trimmed)) return 'zh';
  if (/^ja/i.test(trimmed)) return 'ja';
  return 'en';
}

/**
 * @param {{homeDir?: string}} [opts]
 * @returns {'zh'|'en'|'ja'}
 */
export function getLocale({ homeDir = os.homedir() } = {}) {
  const forced = process.env.OWNMIND_LOCALE_FORCE;
  if (VALID_LOCALES.has(forced)) return forced;

  const cache = readJsonSafe(path.join(homeDir, '.ownmind', 'cache', 'memories.json'));
  const preference = cache?.data?.locale;
  if (VALID_LOCALES.has(preference)) return preference;

  const state = readJsonSafe(path.join(homeDir, '.ownmind', 'state', 'locale.json'));
  const normalized = normalizeDetected(state?.detected);
  if (normalized) return normalized;

  return 'en';
}
