// v1.33.0 — the AI keeps the memory; the MCP side.
//
// Nine new tools (merge, archive, decide, restore, candidates, ask_later, lesson_set,
// task_reopen, handoff_reopen), `force` on ownmind_save, `include_archived` on
// ownmind_search, `evidence` on ownmind_task_done, and a one-line notice on every action so
// the person can undo from the chat. See openspec/changes/v1.33.0-ai-keeps-the-memory/spec.md.
//
// mcp/index.js connects a stdio transport on import and cannot be loaded here (the precedent
// tests/mcp-set-locale-tool.test.js documents), so the wiring is asserted at the source level
// and the behaviour is asserted on mcp/lib/memory-keeping.js, which index.js calls.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  KEEPING_ACTIONS,
  runKeepingAction,
  saveNotice,
  taskDoneNotice,
  assertEvidence,
  EVIDENCE_MIN_LENGTH,
} from '../mcp/lib/memory-keeping.js';
import { runMemorySearch } from '../mcp/lib/memory-search.js';
import { makeOfflineHelpers, formatCacheAge } from '../mcp/offline.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const MCP_SOURCE = readFileSync(join(repoRoot, 'mcp', 'index.js'), 'utf8');

const NEW_TOOLS = [
  'ownmind_consolidation_candidates',
  'ownmind_merge',
  'ownmind_archive',
  'ownmind_decide',
  'ownmind_restore',
  'ownmind_ask_later',
  'ownmind_lesson_set',
  'ownmind_task_reopen',
  'ownmind_handoff_reopen',
];

const UNDO_SUFFIX = '要撤銷跟我說一聲';
const CJK = /[぀-ヿ㐀-鿿]/;
// Product strings a description may quote verbatim — title markers, console button labels,
// the card title, and the exact text the server writes. Everything else must be English.
const PRODUCT_WORDS = [
  '【已結案】', '【已過時】', '待決定', '待確認', '待執行', '還原', '退回', '重開', '還是留', '整理記憶',
  '決定（', '，依據 #source_id）：', '兩次未確認，自動歸檔',
];
const withoutProductWords = (s) => PRODUCT_WORDS.reduce((acc, w) => acc.split(w).join(''), s);

function extractToolBlock(toolName) {
  const startIdx = MCP_SOURCE.indexOf(`name: "${toolName}"`);
  assert.ok(startIdx > 0, `tool "${toolName}" definition not found`);
  const rest = MCP_SOURCE.slice(startIdx);
  const nextNameIdx = rest.indexOf('\n    name: "', 5);
  const nextEndIdx = rest.indexOf('\n];');
  const endIdx = (nextNameIdx === -1 || (nextEndIdx !== -1 && nextEndIdx < nextNameIdx))
    ? nextEndIdx : nextNameIdx;
  return rest.slice(0, endIdx > 0 ? endIdx : rest.length);
}

function extractCaseBlock(toolName) {
  const startIdx = MCP_SOURCE.indexOf(`case "${toolName}":`);
  assert.ok(startIdx > 0, `case "${toolName}" handler not found`);
  const rest = MCP_SOURCE.slice(startIdx);
  const nextCaseIdx = rest.indexOf('\n    case "', 5);
  return rest.slice(0, nextCaseIdx > 0 ? nextCaseIdx : 3000);
}

function requiredOf(block) {
  const m = block.match(/required:\s*\[([^\]]*)\]/);
  assert.ok(m, 'required list not found');
  return m[1].split(',').map((s) => s.trim().replace(/"/g, '')).filter(Boolean);
}

function descriptionOf(block) {
  const m = block.match(/description:\s*"((?:[^"\\]|\\.)*)"/);
  assert.ok(m, 'description string not found');
  return m[1];
}

/** A callApi stub that records the call and answers with a fixed body. */
function recorder(reply) {
  const calls = [];
  const callApi = async (method, path, body) => {
    calls.push({ method, path, body });
    return typeof reply === 'function' ? reply({ method, path, body }) : reply;
  };
  return { calls, callApi };
}

describe('v1.33.0 — the nine tools are registered and handled', () => {
  for (const name of NEW_TOOLS) {
    it(`${name} is declared in TOOLS and has a case in handleTool`, () => {
      assert.ok(MCP_SOURCE.includes(`name: "${name}"`), `${name} is declared`);
      assert.ok(MCP_SOURCE.includes(`case "${name}":`), `${name} is handled`);
      assert.ok(KEEPING_ACTIONS[name], `${name} has an action table entry`);
    });

    it(`${name} has an English description written for the AI`, () => {
      const desc = descriptionOf(extractToolBlock(name));
      assert.ok(desc.length > 80, `${name}: a description this short does not say when to use the tool`);
      assert.ok(!CJK.test(withoutProductWords(desc)),
        `${name}: the description must be English (product words such as 待決定 may be quoted)`);
    });

    it(`${name} has a banner label`, () => {
      assert.match(MCP_SOURCE, new RegExp(`^  ${name}: '[^']+',$`, 'm'));
    });
  }

  it('the required arguments match the contract', () => {
    assert.deepEqual(requiredOf(extractToolBlock('ownmind_merge')), ['keep', 'drop']);
    assert.deepEqual(requiredOf(extractToolBlock('ownmind_archive')), ['id', 'reason']);
    assert.deepEqual(requiredOf(extractToolBlock('ownmind_decide')), ['id', 'decision', 'source_id']);
    assert.deepEqual(requiredOf(extractToolBlock('ownmind_restore')), ['id']);
    assert.deepEqual(requiredOf(extractToolBlock('ownmind_ask_later')), ['memory_id', 'question']);
    assert.deepEqual(requiredOf(extractToolBlock('ownmind_lesson_set')), ['id', 'status']);
    assert.deepEqual(requiredOf(extractToolBlock('ownmind_task_reopen')), ['id']);
    assert.deepEqual(requiredOf(extractToolBlock('ownmind_handoff_reopen')), ['id']);
    assert.deepEqual(requiredOf(extractToolBlock('ownmind_consolidation_candidates')), []);
  });

  it('lesson_set accepts exactly promoted | dismissed', () => {
    const block = extractToolBlock('ownmind_lesson_set');
    const m = block.match(/enum:\s*\[([^\]]*)\]/);
    assert.ok(m, 'status enum not found');
    assert.deepEqual(m[1].split(',').map((s) => s.trim().replace(/"/g, '')).sort(), ['dismissed', 'promoted']);
  });

  it('the descriptions say when NOT to use the tool', () => {
    // archive is for project memories whose subject ended; wrong ones go to disable.
    const archive = descriptionOf(extractToolBlock('ownmind_archive'));
    assert.match(archive, /ownmind_disable/);
    assert.match(archive, /project/);
    assert.match(archive, /iron rule/i);
    // merge is for duplicates, not for wrong or ended memories.
    const merge = descriptionOf(extractToolBlock('ownmind_merge'));
    assert.match(merge, /ownmind_disable/);
    assert.match(merge, /ownmind_archive/);
    assert.match(merge, /newer wins/i);
    // decide needs a newer source.
    const decide = descriptionOf(extractToolBlock('ownmind_decide'));
    assert.match(decide, /newer|after/i);
    assert.match(decide, /source_id/);
    // ask_later is for what the machine cannot answer.
    const ask = descriptionOf(extractToolBlock('ownmind_ask_later'));
    assert.match(ask, /git log|file system|server/i);
    // the disable description now points at archive for ended subjects.
    const disable = descriptionOf(extractToolBlock('ownmind_disable'));
    assert.match(disable, /ownmind_archive/);
  });
});

describe('v1.33.0 — the action table: method, path, body', () => {
  const token = 'tok-1';
  const run = (name, args, reply = { id: 1, sync_token: 'tok-2' }) => {
    const r = recorder(reply);
    return runKeepingAction({ callApi: r.callApi, syncToken: token }, name, args).then((out) => ({ out, calls: r.calls }));
  };

  it('candidates: GET /api/memory/consolidation/candidates, no body, no undo notice', async () => {
    const reply = { duplicates: [], concluded: [], stale: [], waiting: [], lessons: [], closed_tasks: [] };
    const { out, calls } = await run('ownmind_consolidation_candidates', {}, reply);
    assert.deepEqual(calls, [{ method: 'GET', path: '/api/memory/consolidation/candidates', body: undefined }]);
    assert.deepEqual(out, reply, 'a read changes nothing, so there is nothing to undo');
  });

  it('merge: POST /api/memory/merge {keep, drop, sync_token}', async () => {
    const { out, calls } = await run('ownmind_merge', { keep: 9, drop: 12 });
    assert.deepEqual(calls, [{ method: 'POST', path: '/api/memory/merge', body: { keep: 9, drop: 12, sync_token: token } }]);
    assert.equal(out.notice, '已把 #12 併進 #9，要撤銷跟我說一聲');
  });

  it('archive: POST /api/memory/:id/archive {reason, sync_token}', async () => {
    const { out, calls } = await run('ownmind_archive', { id: 745, reason: '主機已退役' });
    assert.deepEqual(calls, [{ method: 'POST', path: '/api/memory/745/archive', body: { reason: '主機已退役', sync_token: token } }]);
    assert.equal(out.notice, '已歸檔 #745，要撤銷跟我說一聲');
  });

  it('decide: POST /api/memory/:id/decide {decision, source_id, sync_token}', async () => {
    const { out, calls } = await run('ownmind_decide', { id: 100, decision: '改用 B 方案', source_id: 140 });
    assert.deepEqual(calls, [{ method: 'POST', path: '/api/memory/100/decide', body: { decision: '改用 B 方案', source_id: 140, sync_token: token } }]);
    assert.equal(out.notice, '已在 #100 記下決定（依據 #140），要撤銷跟我說一聲');
  });

  it('restore: POST /api/memory/:id/restore {sync_token}', async () => {
    const { out, calls } = await run('ownmind_restore', { id: 745 });
    assert.deepEqual(calls, [{ method: 'POST', path: '/api/memory/745/restore', body: { sync_token: token } }]);
    assert.equal(out.notice, '已把 #745 還原成有效記憶，要撤銷跟我說一聲');
  });

  it('ask_later: POST /api/memory/consolidation/questions {memory_id, question, sync_token}', async () => {
    const { out, calls } = await run('ownmind_ask_later', { memory_id: 300, question: 'Adam 開 API 了嗎？' });
    assert.deepEqual(calls, [{ method: 'POST', path: '/api/memory/consolidation/questions', body: { memory_id: 300, question: 'Adam 開 API 了嗎？', sync_token: token } }]);
    assert.equal(out.notice, '已記下要問你的問題（記憶 #300），要撤銷跟我說一聲');
  });

  it('lesson_set: PUT /api/session/lessons/:id/set {status, reason?, sync_token}', async () => {
    const kept = await run('ownmind_lesson_set', { id: 7, status: 'promoted' });
    assert.deepEqual(kept.calls, [{ method: 'PUT', path: '/api/session/lessons/7/set', body: { status: 'promoted', sync_token: token } }]);
    assert.equal(kept.out.notice, '已把教訓 #7 留成記憶，要撤銷跟我說一聲');

    const dropped = await run('ownmind_lesson_set', { id: 8, status: 'dismissed', reason: 'CLAUDE.md 已經寫了' });
    assert.deepEqual(dropped.calls, [{ method: 'PUT', path: '/api/session/lessons/8/set', body: { status: 'dismissed', reason: 'CLAUDE.md 已經寫了', sync_token: token } }]);
    assert.equal(dropped.out.notice, '已把教訓 #8 標成不留，要撤銷跟我說一聲');
  });

  it('task_reopen: PUT /api/tasks/:id/reopen {note?, sync_token}', async () => {
    const { out, calls } = await run('ownmind_task_reopen', { id: 12, note: '測試其實沒過' });
    assert.deepEqual(calls, [{ method: 'PUT', path: '/api/tasks/12/reopen', body: { note: '測試其實沒過', sync_token: token } }]);
    assert.equal(out.notice, '已把卡片 #12 退回待辦，要撤銷跟我說一聲');

    const bare = await run('ownmind_task_reopen', { id: 12 });
    assert.deepEqual(bare.calls[0].body, { sync_token: token }, 'an absent note is not sent as undefined');
  });

  it('handoff_reopen: PUT /api/handoff/:id/reopen {sync_token}', async () => {
    const { out, calls } = await run('ownmind_handoff_reopen', { id: 5 });
    assert.deepEqual(calls, [{ method: 'PUT', path: '/api/handoff/5/reopen', body: { sync_token: token } }]);
    assert.equal(out.notice, '已把交接 #5 退回待接手，要撤銷跟我說一聲');
  });

  it('every write returns the server body plus a notice ending in the undo phrase', async () => {
    const writes = Object.keys(KEEPING_ACTIONS).filter((n) => KEEPING_ACTIONS[n].method !== 'GET');
    assert.equal(writes.length, 8);
    for (const name of writes) {
      const { out } = await run(name, { id: 1, keep: 1, drop: 2, reason: 'r', decision: 'd', source_id: 3, memory_id: 1, question: 'q', status: 'promoted' });
      assert.equal(out.id, 1, `${name}: the server body is passed through`);
      assert.equal(out.sync_token, 'tok-2', `${name}: the fresh sync token is passed through`);
      assert.ok(out.notice.endsWith(UNDO_SUFFIX), `${name}: notice "${out.notice}" must end in ${UNDO_SUFFIX}`);
      assert.ok(!out.notice.includes('\n'), `${name}: the notice is one line`);
    }
  });

  it('ids are URL-encoded, so a stray value cannot change the route', async () => {
    const { calls } = await run('ownmind_restore', { id: '7/decide' });
    assert.equal(calls[0].path, '/api/memory/7%2Fdecide/restore');
  });

  it('a server error propagates untouched — nothing is queued for later', async () => {
    const callApi = async () => { throw new Error('API 409: source must be newer'); };
    await assert.rejects(
      runKeepingAction({ callApi, syncToken: token }, 'ownmind_decide', { id: 1, decision: 'd', source_id: 2 }),
      /API 409: source must be newer/,
    );
    for (const name of NEW_TOOLS) {
      assert.doesNotMatch(extractCaseBlock(name), /enqueueOperation/, `${name} must not queue offline`);
    }
  });

  it('an unknown action name is refused', async () => {
    await assert.rejects(runKeepingAction({ callApi: async () => ({}), syncToken: token }, 'ownmind_nope', {}), /Unknown/);
  });
});

describe('v1.33.0 — ownmind_save: force and the saved:false notices', () => {
  const block = extractToolBlock('ownmind_save');

  it('declares force as an optional boolean', () => {
    assert.match(block, /force:\s*\{\s*type:\s*"boolean"/);
    assert.ok(!requiredOf(block).includes('force'));
  });

  it('the handler forwards force only when given and attaches the notice', () => {
    const handler = extractCaseBlock('ownmind_save');
    assert.match(handler, /if \(args\.force === true\) body\.force = true;/);
    assert.match(handler, /saveNotice\(/);
  });

  it('exact duplicate → "Already stored as #<id>; nothing was written."', () => {
    assert.equal(
      saveNotice({ saved: false, duplicate_of: { id: 42, title: 'x' } }),
      'Already stored as #42; nothing was written.',
    );
  });

  it('related memories → the count and the two ways forward', () => {
    assert.equal(
      saveNotice({ saved: false, similar: [{ id: 1 }, { id: 2 }, { id: 3 }] }),
      'Not saved: 3 related memories exist. Update the closest one with ownmind_update, or call ownmind_save again with force: true.',
    );
  });

  it('a normal save gets no notice', () => {
    assert.equal(saveNotice({ id: 9, saved: true }), null);
    assert.equal(saveNotice({ id: 9 }), null);
    assert.equal(saveNotice(null), null);
  });
});

describe('v1.33.0 — ownmind_search: include_archived', () => {
  const { isNetworkError, localSearch } = makeOfflineHelpers();
  const deps = (callApi) => ({ callApi, isNetworkError, readMemoryCache: () => null, localSearch, formatCacheAge, logEvent: () => {} });

  it('declares include_archived as an optional boolean', () => {
    const block = extractToolBlock('ownmind_search');
    assert.match(block, /include_archived:\s*\{\s*type:\s*"boolean"/);
    assert.deepEqual(requiredOf(block), ['query']);
    assert.match(extractCaseBlock('ownmind_search'), /includeArchived: args\.include_archived === true/);
  });

  it('passes include_archived=1 to the server only when asked, and rows keep their status', async () => {
    const paths = [];
    const callApi = async (method, path) => {
      paths.push(path);
      if (path.startsWith('/api/memory/search')) {
        return { data: [{ id: 1, title: 'a', status: 'active' }, { id: 2, title: 'b', status: 'archived' }], total: 2, returned: 2 };
      }
      return [];
    };
    const res = await runMemorySearch(deps(callApi), { query: 'host', includeArchived: true });
    assert.match(paths[0], /^\/api\/memory\/search\?q=host.*&include_archived=1/);
    assert.deepEqual(res.data.map((r) => r.status), ['active', 'archived']);

    paths.length = 0;
    await runMemorySearch(deps(callApi), { query: 'host' });
    assert.doesNotMatch(paths[0], /include_archived/, 'the default search stays active-only');
  });
});

describe('v1.33.0 — ownmind_task_done needs evidence; done closes the card', () => {
  const block = extractToolBlock('ownmind_task_done');
  const handler = extractCaseBlock('ownmind_task_done');

  it('evidence is required in the schema and sent to the server', () => {
    assert.deepEqual(requiredOf(block), ['id', 'result', 'evidence']);
    assert.match(handler, /evidence: args\.evidence/);
    assert.match(handler, /assertEvidence\(args\.evidence\)/);
    assert.match(handler, /taskDoneNotice\(/);
  });

  it('the description says to run the verification first and that done closes the card', () => {
    const desc = descriptionOf(block);
    assert.match(desc, /verification/i);
    assert.match(desc, /evidence/);
    assert.match(desc, /ownmind_task_reopen/);
    assert.doesNotMatch(desc, /person reviews it in the console/i);
    assert.doesNotMatch(desc, /cannot mark it reviewed/i);
  });

  it('assertEvidence refuses a method with no output, with the server\'s sentence', () => {
    assert.equal(EVIDENCE_MIN_LENGTH, 20);
    const expected = /evidence is required: the verification you ran and what it printed/;
    assert.throws(() => assertEvidence(undefined), expected);
    assert.throws(() => assertEvidence('   '), expected);
    assert.throws(() => assertEvidence('ran the tests'), expected);
    assert.doesNotThrow(() => assertEvidence('node --test tests/x.test.js → 12 pass, 0 fail'));
  });

  it('the close carries an undo notice naming the card', () => {
    assert.equal(taskDoneNotice(12), '已結案卡片 #12，要撤銷跟我說一聲');
  });
});

describe('v1.33.0 — ownmind_log_session no longer sends lessons to the console', () => {
  it('the description says the AI promotes repeats at once and the rest at the monthly pass', () => {
    const desc = descriptionOf(extractToolBlock('ownmind_log_session'));
    assert.doesNotMatch(desc, /person promotes or dismisses them later in the console/i);
    assert.doesNotMatch(desc, /the AI never writes them into memory itself/i);
    assert.match(desc, /second time|repeat/i);
    assert.match(desc, /monthly/i);
    assert.match(desc, /ownmind_lesson_set/);
  });

  it('the no-lessons notice no longer promises a console review', () => {
    const handler = extractCaseBlock('ownmind_log_session');
    assert.doesNotMatch(handler, /so the person can keep what was learned/);
  });
});
