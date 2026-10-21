/**
 * client/src/lib/memory-write.js
 *
 * v1.33.0 — every memory write (archive, restore, ...) must carry a sync_token, or the
 * server answers 409 `sync_token_required`. The hooks get theirs from init; the console
 * pages have none, so this helper fetches one right before the POST and sends it in the
 * body. A 409 after that (the token went stale between the two calls, or was refused)
 * refetches the token once and retries; a second refusal is returned as is.
 *
 * Pure: `apiPost`/`apiGet` are passed in (both answer `{ ok, status, data, error }`), so
 * node --test can drive it with fakes and the page files stay thin.
 */

export const SYNC_TOKEN_PATH = '/api/memory/sync-token';

/** The token out of a GET /sync-token answer, or null when it did not come. */
export function syncTokenOf(r) {
  const token = r?.ok ? r.data?.sync_token : null;
  return typeof token === 'string' && token ? token : null;
}

/**
 * POST `path` with `body` plus a fresh sync_token. Returns the api result of the write;
 * a token fetch that fails returns that failure instead, so the caller sees why.
 */
export async function postMemoryWrite(apiPost, apiGet, path, body = {}) {
  const first = await apiGet(SYNC_TOKEN_PATH);
  const token = syncTokenOf(first);
  if (!token) return first.ok ? { ok: false, status: first.status, error: 'sync_token_missing' } : first;

  const r = await apiPost(path, { ...body, sync_token: token });
  if (r.ok || r.status !== 409) return r;

  // One retry with a token fetched after the refusal. If the token cannot be fetched
  // again, the original refusal is the better explanation.
  const again = await apiGet(SYNC_TOKEN_PATH);
  const retryToken = syncTokenOf(again);
  if (!retryToken) return r;
  return apiPost(path, { ...body, sync_token: retryToken });
}
