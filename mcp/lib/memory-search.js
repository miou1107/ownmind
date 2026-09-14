import { classifySearchLegs } from './search-legs.js';

/**
 * `ownmind_search`, with its dependencies passed in.
 *
 * #129 — this used to live inline in mcp/index.js, where the only way to reach the offline
 * branch was to have a real network failure, so nothing tested it and a swallowed error sat
 * in it for months: both API calls carried `.catch(() => [])`, the handler's catch block
 * never ran, and a dead connection was reported as `0 hits` with no notice. Taking the flow
 * out of the process lets a test cut the network and read what the caller would have been
 * told.
 *
 * @param {object} deps
 * @param {(method: string, path: string) => Promise<any>} deps.callApi
 * @param {(err: Error) => boolean} deps.isNetworkError
 * @param {() => object|null} deps.readMemoryCache
 * @param {(cache: object|null, query: string) => {data: any[], total: number, returned: number}} deps.localSearch
 * @param {(event: string, payload: object) => void} [deps.logEvent]
 * @param {(savedAt: string|undefined) => string} deps.formatCacheAge
 * @param {object} args
 * @param {string} args.query
 * @param {string} [args.syncToken]
 * @returns {Promise<object>} the tool's response body. `_new_token`, when present, is the
 *   refreshed sync token for the caller to keep.
 */
export async function runMemorySearch(deps, args) {
  const { callApi, isNetworkError, readMemoryCache, localSearch, formatCacheAge } = deps;
  const logEvent = deps.logEvent || (() => {});
  const query = args.query;
  const searchTokenParam = args.syncToken ? `&sync_token=${args.syncToken}` : '';

  const settle = (p) => p.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
  // v1.17.13: search memories + session_logs together and merge (Dana case).
  const [memory, session] = await Promise.all([
    settle(callApi('GET', `/api/memory/search?q=${encodeURIComponent(query)}${searchTokenParam}`)),
    settle(callApi('GET', `/api/session/recent?days=90&include_compressed=true&q=${encodeURIComponent(query)}`)),
  ]);

  const verdict = classifySearchLegs({ memory, session }, isNetworkError);

  if (verdict.mode === 'offline') {
    const cache = readMemoryCache();
    // v1.26.64: localSearch answers in the same {data, total, returned} shape as the server,
    // so both paths hand back the same thing.
    const results = localSearch(cache, query);
    logEvent('memory_search', { query, offline: true });
    return {
      data: results.data,
      memory_total: results.total,
      memory_returned: results.returned,
      _offline: true,
      _offline_notice:
        `[OwnMind offline mode] This session cannot reach the OwnMind server, so these hits come from the local cache (${formatCacheAge(cache?.saved_at)}). `
        + `Local keyword search: ${results.returned} of ${results.total} matches, content is a preview. `
        + 'Anything saved since that cache is missing, so zero hits here is not evidence that nothing is stored. '
        + 'A connection that broke mid-session does not come back on its own — start a new session to search the server again.',
    };
  }

  // Both halves failed for a reason a cache cannot stand in for: the caller must see the
  // error rather than an empty result set.
  if (verdict.mode === 'error') throw verdict.error;

  const memoryRows = memory.ok ? memory.value : [];
  const sessionRows = session.ok ? session.value : [];
  const memoryData = Array.isArray(memoryRows) ? memoryRows : (memoryRows?.data || []);
  const sessionData = Array.isArray(sessionRows) ? sessionRows : [];
  const sessionAsMemory = sessionData.map((s) => ({
    id: s.id,
    type: 'session_log',
    title: (s.summary || '').slice(0, 80),
    content: s.summary,
    details: s.details,
    tool: s.tool,
    model: s.model,
    created_at: s.created_at,
    _source: 'session_logs',
  }));

  logEvent('memory_search', {
    query,
    memory_hits: memoryData.length,
    session_hits: sessionData.length,
    ...(verdict.mode === 'partial' ? { partial: verdict.failed.join(',') } : {}),
  });

  // v1.26.64: memory_total is what matched, memory_returned is what came back. A caller that
  // cannot tell the two apart reads twenty of two hundred results as the whole picture.
  return {
    data: [...memoryData, ...sessionAsMemory],
    memory_hits: memoryData.length,
    session_hits: sessionData.length,
    memory_total: memoryRows?.total ?? memoryData.length,
    memory_returned: memoryRows?.returned ?? memoryData.length,
    ...(memoryRows?.new_token ? { _new_token: memoryRows.new_token } : {}),
    ...(verdict.mode === 'partial' ? { _partial: true, _partial_notice: verdict.notice } : {}),
  };
}
