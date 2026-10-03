import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * v1.30.41 — a notice the person says they already know about can actually be turned off.
 *
 * Before this, every notice told the AI to offer "acknowledged", but no tool the AI held
 * could act on it. The AI answered "noted", nothing was written, and the same notice opened
 * the next conversation. A dismiss was also stored per tool, so even one done by hand in
 * Claude Code came back in Codex or Cursor.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const { renderSessionContext } = await import('../hooks/lib/render-session-context.js');
const { filterVisibleBroadcasts, ALL_TOOLS } = await import('../src/lib/broadcast-filter.js');

const notice = { id: 100, severity: 'warning', title: 'Something broke', body: 'details' };

describe('the AI is told how to turn a notice off', () => {
  it('conversation start shows the notice number and the tool to call', () => {
    const out = renderSessionContext({ server_version: '1.30.40' }, [notice], { tip: () => '' });
    assert.match(out, /\(notice #100\)/);
    assert.match(out, /ownmind_dismiss_notice/);
  });

  it('no notice, no instruction', () => {
    const out = renderSessionContext({ server_version: '1.30.40' }, [], { tip: () => '' });
    assert.doesNotMatch(out, /ownmind_dismiss_notice/);
  });

  it('notices attached to tool results carry the number and the instruction too', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'mcp', 'index.js'), 'utf8');
    assert.match(src, /\(notice #\$\{bc\.id\}\)/);
    assert.match(src, /lines\.push\(DISMISS_HINT\)/);
  });
});

describe('the tool exists and turns the notice off everywhere', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'mcp', 'index.js'), 'utf8');

  it('is declared with a required notice number', () => {
    const decl = src.slice(src.indexOf('name: "ownmind_dismiss_notice"'));
    assert.ok(src.includes('name: "ownmind_dismiss_notice"'));
    assert.match(decl.slice(0, 1500), /required: \["broadcast_id"\]/);
  });

  it('sends the every-tool value, not this tool', () => {
    const handler = src.slice(src.indexOf('case "ownmind_dismiss_notice"'));
    assert.match(handler.slice(0, 800), /tool: '\*'/);
    assert.match(handler.slice(0, 800), /\/api\/broadcast\/dismiss/);
    assert.equal(ALL_TOOLS, '*');
  });
});

/**
 * A tiny stand-in for the two tables that evaluates the WHERE clause the way Postgres does
 * for these columns, so the test fails if the every-tool row stops being consulted.
 */
function fakeDb({ broadcasts, states }) {
  return async (sql, [userId, tool, now]) => {
    const checksState = /s\.dismissed_at IS NULL/.test(sql);
    const joinsAllTools = /sa\.tool = '\*'/.test(sql) && /sa\.dismissed_at IS NULL/.test(sql);
    const hidden = (row) => row && (row.dismissed_at || (row.snooze_until && row.snooze_until > now));
    const rows = broadcasts.filter((b) => {
      const own = states.find((s) => s.broadcast_id === b.id && s.user_id === userId && s.tool === tool);
      const all = states.find((s) => s.broadcast_id === b.id && s.user_id === userId && s.tool === '*');
      if (checksState && hidden(own)) return false;
      if (joinsAllTools && hidden(all)) return false;
      return true;
    });
    return { rows };
  };
}

describe('a notice turned off once stays off in every tool', () => {
  const now = new Date('2026-10-03T10:00:00Z');
  const broadcasts = [{ id: 100 }, { id: 101 }];

  it('turned off for every tool → hidden in claude-code and in codex', async () => {
    const query = fakeDb({ broadcasts, states: [{ broadcast_id: 100, user_id: 1, tool: '*', dismissed_at: now }] });
    for (const tool of ['claude-code', 'codex', 'cursor']) {
      const ids = (await filterVisibleBroadcasts(query, { user_id: 1, tool, now })).map((b) => b.id);
      assert.deepEqual(ids, [101], tool);
    }
  });

  it('turned off for one tool only → still shown in the others', async () => {
    const query = fakeDb({ broadcasts, states: [{ broadcast_id: 100, user_id: 1, tool: 'claude-code', dismissed_at: now }] });
    assert.deepEqual((await filterVisibleBroadcasts(query, { user_id: 1, tool: 'claude-code', now })).map((b) => b.id), [101]);
    assert.deepEqual((await filterVisibleBroadcasts(query, { user_id: 1, tool: 'codex', now })).map((b) => b.id), [100, 101]);
  });

  it('a snooze for every tool hides it until the snooze ends', async () => {
    const until = new Date('2026-10-04T10:00:00Z');
    const query = fakeDb({ broadcasts, states: [{ broadcast_id: 100, user_id: 1, tool: '*', snooze_until: until }] });
    assert.deepEqual((await filterVisibleBroadcasts(query, { user_id: 1, tool: 'codex', now })).map((b) => b.id), [101]);
    const later = new Date('2026-10-05T10:00:00Z');
    assert.deepEqual((await filterVisibleBroadcasts(query, { user_id: 1, tool: 'codex', now: later })).map((b) => b.id), [100, 101]);
  });

  it('someone else turning it off does not hide it from you', async () => {
    const query = fakeDb({ broadcasts, states: [{ broadcast_id: 100, user_id: 2, tool: '*', dismissed_at: now }] });
    assert.deepEqual((await filterVisibleBroadcasts(query, { user_id: 1, tool: 'codex', now })).map((b) => b.id), [100, 101]);
  });
});

describe('turning off everywhere works on a notice already hidden everywhere', () => {
  const now = new Date('2026-10-03T10:00:00Z');
  const broadcasts = [{ id: 100 }];

  it('a notice snoozed everywhere is still found when asked to turn it off for good', async () => {
    const states = [{ broadcast_id: 100, user_id: 1, tool: '*', snooze_until: new Date('2026-10-04T10:00:00Z') }];
    const query = fakeDb({ broadcasts, states });
    assert.deepEqual((await filterVisibleBroadcasts(query, { user_id: 1, tool: '*', now })).map((b) => b.id), []);
    assert.deepEqual(
      (await filterVisibleBroadcasts(query, { user_id: 1, tool: '*', now, ignoreState: true })).map((b) => b.id),
      [100],
    );
  });

  it('the dismiss route skips the state rules only for the every-tool value', () => {
    const route = fs.readFileSync(path.join(repoRoot, 'src', 'routes', 'broadcast.js'), 'utf8');
    const dismiss = route.slice(route.indexOf("router.post('/dismiss'"));
    assert.match(dismiss.slice(0, 2000), /ignoreState: tool === ALL_TOOLS/);
  });
});
