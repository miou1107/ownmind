/**
 * v1.31.3 — the current project's task cards for the session-start context.
 *
 * Not part of the cached init payload on purpose: the cache is served whenever the memory
 * table has not moved, and cards move without it. So the session-start hook asks for them
 * separately, every start, with a short timeout, and merges the answer into the init data
 * before rendering. Nothing to say (no project, no credentials, no server, no table): null,
 * which the renderer treats as no block.
 */

import https from 'https';
import http from 'http';

const TIMEOUT_MS = 3000;
const MAX_CARDS = 5;

export function getJson(url, apiKey, timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { Authorization: `Bearer ${apiKey}` }, timeout }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * @param {object} opts
 * @param {string} opts.apiUrl
 * @param {string} opts.apiKey
 * @param {string|null} opts.project   resolveProjectName()'s answer
 * @param {Function} [opts.fetchJson]  injection point for tests
 * @returns {Promise<{ project: string, cards: Array }|null>}
 */
export async function fetchProjectTasks({ apiUrl, apiKey, project, fetchJson = getJson }) {
  if (!apiUrl || !apiKey || !project) return null;
  try {
    const res = await fetchJson(`${apiUrl.replace(/\/$/, '')}/api/tasks?project=${encodeURIComponent(project)}`, apiKey);
    if (res.status !== 200) return null;
    const rows = JSON.parse(res.body);
    if (!Array.isArray(rows)) return null;
    // The server says whether a card is held by this account (`held_by_me`); the hook never
    // has to know its own id. Mine first, then the rest, at most five.
    const mine = rows.filter((r) => r.held_by_me === true);
    const others = rows.filter((r) => r.held_by_me !== true);
    const cards = [...mine, ...others].slice(0, MAX_CARDS).map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      holder: r.held_by_me === true ? 'you' : (r.claimed_by ? (r.holder_name || null) : null),
    }));
    return { project, cards };
  } catch {
    return null;
  }
}
