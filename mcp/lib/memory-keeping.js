/**
 * v1.33.0 — the AI keeps the memory; the console only shows and undoes.
 *
 * The nine actions an AI takes while working the monthly consolidation card, plus the pieces
 * of ownmind_save and ownmind_task_done that changed with them. The table is here rather than
 * inline in mcp/index.js so a test can hand in a stubbed `callApi` and read the exact method,
 * path and body each tool sends — mcp/index.js connects a stdio transport on import and cannot
 * be loaded by a test.
 *
 * Every write returns the server body plus a one-line `notice` the AI relays to the person,
 * ending in 要撤銷跟我說一聲: the person never pressed anything, so the chat is where the undo
 * has to be offered. The read (candidates) changes nothing and carries no notice.
 *
 * None of these queue offline. Each one updates rows by id against the state the server holds
 * now; an action that lands silently minutes later cannot be told apart from one that never
 * went, and the person would be offered an undo for something that had not happened yet.
 */

const UNDO = '要撤銷跟我說一聲';
const enc = (v) => encodeURIComponent(String(v));

/** `{key: value}` without the keys whose value is undefined, so an absent optional is not sent. */
function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/**
 * Tool name → how it reaches the server and what the person is told afterwards.
 * `path` and `body` take the tool's args; `notice` takes the args and the server body.
 */
export const KEEPING_ACTIONS = {
  ownmind_consolidation_candidates: {
    method: 'GET',
    path: () => '/api/memory/consolidation/candidates',
  },
  ownmind_merge: {
    method: 'POST',
    path: () => '/api/memory/merge',
    body: (a) => ({ keep: a.keep, drop: a.drop }),
    notice: (a) => `已把 #${a.drop} 併進 #${a.keep}，${UNDO}`,
  },
  ownmind_archive: {
    method: 'POST',
    path: (a) => `/api/memory/${enc(a.id)}/archive`,
    body: (a) => ({ reason: a.reason }),
    notice: (a) => `已歸檔 #${a.id}，${UNDO}`,
  },
  ownmind_decide: {
    method: 'POST',
    path: (a) => `/api/memory/${enc(a.id)}/decide`,
    body: (a) => ({ decision: a.decision, source_id: a.source_id }),
    notice: (a) => `已在 #${a.id} 記下決定（依據 #${a.source_id}），${UNDO}`,
  },
  ownmind_restore: {
    method: 'POST',
    path: (a) => `/api/memory/${enc(a.id)}/restore`,
    body: () => ({}),
    notice: (a) => `已把 #${a.id} 還原成有效記憶，${UNDO}`,
  },
  ownmind_ask_later: {
    method: 'POST',
    path: () => '/api/memory/consolidation/questions',
    body: (a) => ({ memory_id: a.memory_id, question: a.question }),
    notice: (a) => `已記下要問你的問題（記憶 #${a.memory_id}），${UNDO}`,
  },
  ownmind_lesson_set: {
    method: 'PUT',
    path: (a) => `/api/session/lessons/${enc(a.id)}/set`,
    body: (a) => compact({ status: a.status, reason: a.reason }),
    notice: (a) => (a.status === 'dismissed'
      ? `已把教訓 #${a.id} 標成不留，${UNDO}`
      : `已把教訓 #${a.id} 留成記憶，${UNDO}`),
  },
  ownmind_task_reopen: {
    method: 'PUT',
    path: (a) => `/api/tasks/${enc(a.id)}/reopen`,
    body: (a) => compact({ note: a.note }),
    notice: (a) => `已把卡片 #${a.id} 退回待辦，${UNDO}`,
  },
  ownmind_handoff_reopen: {
    method: 'PUT',
    path: (a) => `/api/handoff/${enc(a.id)}/reopen`,
    body: () => ({}),
    notice: (a) => `已把交接 #${a.id} 退回待接手，${UNDO}`,
  },
};

/**
 * Run one of the actions above.
 *
 * @param {object} deps
 * @param {(method: string, path: string, body?: object) => Promise<any>} deps.callApi
 * @param {string|undefined} deps.syncToken sent with every write, the way the other write
 *   tools send it; the caller keeps the `sync_token` the server returns
 * @param {string} name the tool name
 * @param {object} args the tool's arguments
 * @returns {Promise<object>} the server body, plus `notice` on a write
 */
export async function runKeepingAction({ callApi, syncToken }, name, args) {
  const action = KEEPING_ACTIONS[name];
  if (!action) throw new Error(`Unknown memory-keeping action: ${name}`);
  const a = (args && typeof args === 'object') ? args : {};
  const path = action.path(a);

  const data = action.method === 'GET'
    ? await callApi('GET', path)
    : await callApi(action.method, path, { ...action.body(a), sync_token: syncToken });

  const body = (data && typeof data === 'object' && !Array.isArray(data)) ? data : { result: data };
  if (!action.notice) return body;
  return { ...body, notice: action.notice(a, body) };
}

/**
 * The line ownmind_save adds when the server declined to insert. `null` on a normal save.
 * Wording is the contract in spec.md; the AI reads it, so it is English like the tool text.
 */
export function saveNotice(data) {
  if (!data || typeof data !== 'object' || data.saved !== false) return null;
  if (data.duplicate_of && data.duplicate_of.id !== undefined) {
    return `Already stored as #${data.duplicate_of.id}; nothing was written.`;
  }
  const n = Array.isArray(data.similar) ? data.similar.length : 0;
  return `Not saved: ${n} related memories exist. Update the closest one with ownmind_update, or call ownmind_save again with force: true.`;
}

/** `evidence` on ownmind_task_done: the verification the AI ran and what it printed. */
export const EVIDENCE_MIN_LENGTH = 20;
const EVIDENCE_ERROR = 'evidence is required: the verification you ran and what it printed';

/**
 * Refuse a done call whose evidence could not be the output of anything, before the network
 * round-trip. Same sentence as the server's 400, so the AI sees one message either way.
 */
export function assertEvidence(evidence) {
  if (typeof evidence !== 'string' || evidence.trim().length < EVIDENCE_MIN_LENGTH) {
    throw new Error(`${EVIDENCE_ERROR} (at least ${EVIDENCE_MIN_LENGTH} characters)`);
  }
}

/** done closes the card; nobody reviews it, so the undo is offered here. */
export function taskDoneNotice(id) {
  return `已結案卡片 #${id}，${UNDO}`;
}
