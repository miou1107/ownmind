import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { renderSessionContext, handoffMatchesProject } = await import('../hooks/lib/render-session-context.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('renderSessionContext — broadcasts', () => {
  it('no broadcasts → output omits the notification section', () => {
    const out = renderSessionContext({ server_version: '1.17.0' }, []);
    assert.doesNotMatch(out, /OwnMind broadcast/);
    assert.match(out, /OwnMind v1\.17\.0/);
  });

  it('broadcasts appear at the top (before memory)', () => {
    const out = renderSessionContext(
      { server_version: '1.17.0' },
      [{ title: '維護通知', body: '週五晚 10pm', severity: 'warning' }]
    );
    const bcIdx = out.indexOf('OwnMind broadcast');
    const memIdx = out.indexOf('Memory loaded');
    assert.ok(bcIdx >= 0 && memIdx >= 0);
    assert.ok(bcIdx < memIdx, 'broadcast should be before memory');
  });

  it('rendered upgrade reminder includes the CTA + snooze hint', () => {
    const out = renderSessionContext({ server_version: '1.17.0' }, [{
      title: 'OwnMind 有新版本', body: '落後請升級',
      severity: 'warning', cta_text: '我要升級', cta_action: 'upgrade_ownmind',
      allow_snooze: true, snooze_hours: 24
    }]);
    assert.match(out, /我要升級/);
    assert.match(out, /let the AI run the upgrade/);
    assert.match(out, /defer for 24 hours/);
  });

  it('a long broadcast keeps its lines, and says so when it does cut', () => {
    // Bug #26. The body went through `.split('\n').slice(0, 5).join(' ').slice(0, 400)` —
    // three lossy operations in one line, none of them announced. A team standard posted as a
    // ten-line notice arrived as one run-on sentence stopping mid-word, and neither the person
    // who wrote it nor the person reading it could tell anything was missing. The cap itself is
    // fine; a cap that lies about being a cap is not.
    const body = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行：這一行要看得到`).join('\n');
    const out = renderSessionContext({}, [{ title: 't', body, severity: 'info' }], { tip: () => '' });

    assert.match(out, /第 6 行/, 'the sixth line was dropped and nobody was told');
    assert.match(out, /第 12 行/, 'the last line was dropped and nobody was told');
    assert.doesNotMatch(out, /第 1 行：這一行要看得到 第 2 行/,
      'the lines were joined into one run-on sentence');
  });

  it('a body past the cap is cut, and the cut is stated', () => {
    // The cap stays — an admin pasting a whole document must not flood every session start.
    // What changes is that being cut is visible, the way "N more broadcast(s) not shown"
    // already is for the broadcast list right below it.
    const body = 'x'.repeat(5000);
    const out = renderSessionContext({}, [{ title: 't', body, severity: 'info' }], { tip: () => '' });
    assert.match(out, /沒顯示|not shown/, 'it was cut and said nothing about it');
  });

  it('nothing the server would accept gets cut here', () => {
    // The server refuses a body over 2000 characters. If this side cut earlier than that, an
    // admin could write a broadcast the server accepted and every member would silently
    // receive less of it — which is bug #26 exactly, just with different numbers. Read from
    // the server's own validator so the two cannot drift apart.
    const validator = fs.readFileSync(path.join(repoRoot, 'src', 'routes', 'broadcast.js'), 'utf8');
    const m = validator.match(/body\.body\.length > (\d+)/);
    assert.ok(m, "the server's body limit could not be found — this check has stopped working");
    const serverMax = Number(m[1]);

    const body = 'a'.repeat(serverMax);
    const out = renderSessionContext({}, [{ title: 't', body, severity: 'info' }], { tip: () => '' });
    assert.doesNotMatch(out, /沒顯示/,
      `the server accepts ${serverMax} characters and this cut a body that size`);
  });

  it('a short broadcast is not marked as cut', () => {
    // The control: a truthful "nothing was cut" has to be distinguishable from the notice.
    const out = renderSessionContext({}, [{ title: 't', body: '兩行\n就這樣', severity: 'info' }], { tip: () => '' });
    assert.match(out, /就這樣/);
    assert.doesNotMatch(out, /沒顯示/, 'nothing was cut, so nothing may claim it was');
  });

  it('renders at most 3 broadcasts; the rest are summarized', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      title: `廣播 ${i}`, body: 'x'.repeat(50), severity: 'info'
    }));
    const out = renderSessionContext({ server_version: '1.17.0' }, many);
    assert.ok(out.includes('廣播 0'));
    assert.ok(out.includes('廣播 2'));
    assert.ok(!out.includes('廣播 3'), 'the 4th broadcast body should not render');
    assert.match(out, /2 more broadcast\(s\) not shown/);
  });

  it('a body is still capped, so one broadcast cannot flood every session', () => {
    // The cap survives the bug-#26 fix: a broadcast is pasted into every member's session
    // start, so an admin pasting a document must not cost everybody their context. What the
    // fix changed is that being cut is now stated, not that cutting stopped.
    const longBody = 'x'.repeat(20000);
    const out = renderSessionContext({ server_version: '1.17.0' }, [{
      title: '長廣播', body: longBody, severity: 'info'
    }]);
    assert.ok(out.length < 6000, `one broadcast produced ${out.length} characters of context`);
  });

  it('a multi-line body stays multi-line, and every line is quoted', () => {
    // It used to be `.slice(0, 5).join(' ')`: five lines, run together into one. A numbered
    // list arrived as a sentence, and lines 6 onward simply were not there.
    const multiline = Array.from({ length: 10 }, (_, i) => `Line ${i}`).join('\n');
    const out = renderSessionContext({ server_version: '1.17.0' }, [{
      title: '多行', body: multiline, severity: 'info'
    }]);
    for (let i = 0; i < 10; i += 1) {
      assert.ok(out.includes(`> Line ${i}`), `Line ${i} is missing, or lost its quote marker`);
    }
  });

  it('error-severity broadcasts append a SYSTEM action-required block', () => {
    const out = renderSessionContext({ server_version: '1.17.0' }, [{
      title: '嚴重錯誤', body: '請立即處理', severity: 'error'
    }]);
    assert.match(out, /\[SYSTEM\] Action required/);
  });

  it('warning-severity broadcasts append a SYSTEM action-required block', () => {
    const out = renderSessionContext({ server_version: '1.17.0' }, [{
      title: '安全更新', body: '請盡快升級', severity: 'warning'
    }]);
    assert.match(out, /\[SYSTEM\] Action required/);
  });

  it('upgrade_reminder type broadcast appends a SYSTEM action-required block', () => {
    const out = renderSessionContext({ server_version: '1.17.0' }, [{
      title: 'OwnMind 有新版本', body: '請升級', severity: 'info', type: 'upgrade_reminder'
    }]);
    assert.match(out, /\[SYSTEM\] Action required/);
  });

  it('info severity that is not upgrade_reminder does not append the action-required block', () => {
    const out = renderSessionContext({ server_version: '1.17.0' }, [{
      title: '一般公告', body: '系統維護', severity: 'info', type: 'announcement'
    }]);
    assert.doesNotMatch(out, /\[SYSTEM\] Action required/);
  });
});

describe('renderSessionContext — memory', () => {
  it('renders a server_version placeholder when data has no version', () => {
    const out = renderSessionContext({}, []);
    assert.match(out, /OwnMind v\?/);
  });

  it('shows profile / iron_rules_digest / principles / active_handoff', () => {
    const out = renderSessionContext({
      server_version: '1.17.0',
      profile: { title: '身份', content: 'Vin' },
      iron_rules_digest: 'IR-001: 不要 commit .env',
      principles: [{ title: '通用性' }, { title: '零負擔' }],
      active_handoff: { project: 'ownmind' }
    }, []);
    assert.match(out, /身份.*Vin/);
    assert.match(out, /IR-001/);
    assert.match(out, /- 通用性/);
    assert.match(out, /- 零負擔/);
    // v1.33.0: a handoff is a section with its content when this directory is its project, and
    // one reminder line naming the project otherwise. No project was given here.
    assert.match(out, /## Handoffs waiting in other projects/);
    assert.match(out, /\(ownmind\)/);
    assert.doesNotMatch(out, /Project: ownmind/);
  });

  it('missing sections do not crash', () => {
    const out = renderSessionContext({}, []);
    assert.ok(out.length > 0);
    assert.match(out, /OwnMind/);
  });
});

describe('renderSessionContext — fixed trailer', () => {
  it('trailer contains the MCP tool hint', () => {
    const out = renderSessionContext({}, []);
    assert.match(out, /ownmind_\* MCP tools/);
  });
});

// v1.19: iron-rule tier distribution summary
describe('renderSessionContext — v1.19 tier distribution summary', () => {
  it('with tier_counts present, the iron-rule heading shows the distribution', () => {
    const out = renderSessionContext({
      server_version: '1.19.0',
      iron_rules_digest: 'IR-002: test',
      iron_rules_tier_counts: { critical: 10, default: 25, advisory: 6, total: 41 },
    }, []);
    assert.match(out, /41 total/);
    assert.match(out, /🔴 Critical 10/);
    assert.match(out, /🟡 Default 25/);
    assert.match(out, /⚪ Advisory 6/);
  });

  it('without tier_counts (older server), the iron-rule heading falls back to the legacy format', () => {
    const out = renderSessionContext({
      server_version: '1.18.0',
      iron_rules_digest: 'IR-002: test',
    }, []);
    assert.match(out, /## Iron rules \(strictly enforced\)\n/);
    assert.ok(!out.includes('0 total'), 'must not show a fake count');
  });

  it('with total === 0, no summary number is shown', () => {
    const out = renderSessionContext({
      server_version: '1.19.0',
      iron_rules_digest: 'IR-002: test',
      iron_rules_tier_counts: { critical: 0, default: 0, advisory: 0, total: 0 },
    }, []);
    assert.ok(!out.includes('0 total'), 'total 0 should not display the count');
  });
});

describe('renderSessionContext — team standards', () => {
  // v1.26.128. `/api/memory/init` returns team_standards_digest outside its `!compact`
  // guard — deliberately sent on this path, since every live caller here asks for compact.
  // This renderer never read it, so a team's rules reached anyone whose tool calls
  // ownmind_init and nobody whose tool loads memory through the SessionStart hook. Claude
  // Code is entirely in the second group.
  //
  // Same shape as the missing tip: the server sent it, the renderer dropped it, and the
  // only visible symptom was an AI that did not follow rules it was never given.
  it('renders the digest the init response carries', () => {
    const out = renderSessionContext({
      server_version: '1.26.128',
      team_standards_digest: '[團隊] 前端命名規範\n[團隊] API 錯誤碼',
    }, []);
    assert.match(out, /## Team standards/);
    assert.match(out, /前端命名規範/);
    assert.match(out, /API 錯誤碼/);
  });

  it('points at how to read one in full', () => {
    // The digest is titles only. Without this the AI sees a rule's name and no way to obey it.
    //
    // v1.26.141: this used to assert `standard_detail`, which was the instruction the renderer
    // gave and which returns `{"data": []}` for a standard whose text is held on its own
    // record — the case for every standard written recently. The test pinned the defect: it
    // checked that *an* instruction was present, never that following it arrives anywhere.
    // It now names the route that works. See tests/session-context-lookup-instructions.test.js.
    const out = renderSessionContext({
      server_version: '1.26.141',
      team_standards_digest: '[團隊] 前端命名規範',
    }, []);
    assert.match(out, /ownmind_search/);
    assert.doesNotMatch(out, /ownmind_get\(["']standard_detail["']\)/);
  });

  it('omits the section entirely when the user has no team standards', () => {
    const out = renderSessionContext({ server_version: '1.26.128' }, []);
    assert.doesNotMatch(out, /Team standards/);
  });

  it('puts team standards after the iron rules, not above them', () => {
    // Iron rules outrank team standards when the two conflict; order says so without a
    // sentence about it.
    const out = renderSessionContext({
      server_version: '1.26.128',
      iron_rules_digest: 'IR-001: 範例',
      team_standards_digest: '[團隊] 前端命名規範',
    }, []);
    assert.ok(out.indexOf('Iron rules') < out.indexOf('Team standards'));
  });
});

// v1.33.0 — the AI keeps the memory: handoffs accepted by the matching project, the monthly
// consolidation card, and the two things that stopped being said.
describe('renderSessionContext — handoffs (v1.33.0)', () => {
  const zh = (key, params) => ({
    'handoff.waitingElsewhere': `你有一筆 ${params.project} 的交接還沒接，在那個專案開對話就會接手`,
    'handoff.accepted': `已接手 ${params.project} 的交接，要撤銷跟我說一聲`,
    'handoff.takenByAnotherWindow': `另一個視窗 ${params.minutes} 分鐘前接走`,
    'handoff.waitingElsewhereMore': `另外還有 ${params.count} 筆交接在別的專案沒接，後台的交接頁看得到`,
  }[key] || key);
  const base = { server_version: '1.33.0' };
  const pending = { id: 12, project: 'nantou-funbus', from_machine: 'mac-studio', content: '查到一半的 KOL 名單\n下一步：對 10 月排程', status: 'pending' };

  it('the matching project gets the content and the accept instruction', () => {
    const out = renderSessionContext({ ...base, handoffs: [pending] }, [], { tip: () => '', t: zh, projectAliases: ['nantou-funbus'], machine: 'vin-mbp' });
    assert.match(out, /## Handoff to accept now \(#12, from mac-studio\)/);
    assert.match(out, /查到一半的 KOL 名單/);
    assert.match(out, /下一步：對 10 月排程/);
    assert.match(out, /ownmind_handoff_accept\(\{ id: 12, accepted_by: "vin-mbp" \}\)/);
    assert.match(out, /已接手 nantou-funbus 的交接，要撤銷跟我說一聲/);
    assert.doesNotMatch(out, /## Pending handoff/);
  });

  it('many waiting handoffs name the newest three and count the rest (v1.33.1)', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ...pending, id: 100 + i, project: `proj-${i}` }));
    const out = renderSessionContext({ ...base, handoffs: many }, [], { tip: () => '', t: zh, projectAliases: ['line-summarizer-bot'], machine: 'vin-mbp' });
    assert.match(out, /- #100 \(proj-0\)/);
    assert.match(out, /- #102 \(proj-2\)/);
    assert.doesNotMatch(out, /- #103 \(proj-3\)/);
    assert.match(out, /and 6 more: .*另外還有 6 筆交接在別的專案沒接，後台的交接頁看得到/);
    assert.equal((out.match(/的交接還沒接/g) || []).length, 3);
  });

  it('a different project gets one reminder line and no content', () => {
    const out = renderSessionContext({ ...base, handoffs: [pending] }, [], { tip: () => '', t: zh, projectAliases: ['line-summarizer-bot'], machine: 'vin-mbp' });
    assert.match(out, /## Handoffs waiting in other projects/);
    assert.match(out, /- #12 \(nantou-funbus\): .*你有一筆 nantou-funbus 的交接還沒接，在那個專案開對話就會接手/);
    assert.doesNotMatch(out, /查到一半的 KOL 名單/);
    assert.doesNotMatch(out, /ownmind_handoff_accept/);
  });

  it('matches exactly (case-insensitive), on leading whole segments, and on the git remote alias', () => {
    assert.ok(handoffMatchesProject('Vinutes', ['vinutes']));
    assert.ok(handoffMatchesProject('nantou-funbus', ['nantou-funbus-admin']), 'a sub-project extends its parent\'s name');
    assert.ok(handoffMatchesProject('nantou-funbus-admin', ['nantou-funbus']), 'and the other way round');
    assert.ok(handoffMatchesProject('ownmind', ['OwnMind-worktree', 'ownmind']));
    assert.ok(handoffMatchesProject('nantou_funbus', ['Nantou FunBus.admin']), 'underscore, space and dot split segments too');
    assert.ok(handoffMatchesProject('fapa/api', ['fapa']), 'a slash splits segments');
    assert.ok(!handoffMatchesProject('idaytour', ['vinutes']));
  });

  it('never matches a substring inside a segment, nor a segment that is not at the start', () => {
    assert.ok(!handoffMatchesProject('api', ['fapa-api-gateway']), 'api is not the project fapa-api-gateway');
    assert.ok(!handoffMatchesProject('ai', ['main']), 'ai inside main');
    assert.ok(!handoffMatchesProject('bot', ['line-summarizer-bot']), 'bot is not the project line-summarizer-bot');
    assert.ok(!handoffMatchesProject('funbus', ['nantou-funbus']), 'a trailing segment is the bot case again');
    assert.ok(!handoffMatchesProject('mind', ['ownmind']), 'mind inside ownmind');
    assert.ok(!handoffMatchesProject('ownmind-dev', ['ownmind-worktree']), 'sharing a first segment is not enough');
    assert.ok(!handoffMatchesProject('', ['vinutes']), 'a blank project matches nothing');
    assert.ok(!handoffMatchesProject('vinutes', []), 'no aliases match nothing');
    assert.ok(!handoffMatchesProject('vinutes', ['']), 'a blank alias matches nothing');
    assert.ok(!handoffMatchesProject('-', ['-']), 'nothing but separators matches nothing');
  });

  it('accepted five minutes ago in the matching project: content plus the other-window note', () => {
    const now = Date.parse('2026-10-21T10:00:00Z');
    const accepted = { ...pending, status: 'accepted', accepted_by: 'vin-mini', accepted_at: '2026-10-21T09:55:00Z' };
    const out = renderSessionContext({ ...base, handoffs: [accepted] }, [], { tip: () => '', t: zh, projectAliases: ['nantou-funbus'], now });
    assert.match(out, /## Handoff #12 was taken by another window 5 minute\(s\) ago/);
    assert.match(out, /查到一半的 KOL 名單/);
    assert.match(out, /另一個視窗 5 分鐘前接走/);
    assert.doesNotMatch(out, /ownmind_handoff_accept/, 'must not be accepted a second time');
  });

  it('accepted longer ago, or in another project, is not rendered at all', () => {
    const now = Date.parse('2026-10-21T10:00:00Z');
    const old = { ...pending, status: 'accepted', accepted_at: '2026-10-21T09:00:00Z' };
    const out1 = renderSessionContext({ ...base, handoffs: [old] }, [], { tip: () => '', t: zh, projectAliases: ['nantou-funbus'], now });
    assert.doesNotMatch(out1, /Handoff/);
    const recentElsewhere = { ...pending, status: 'accepted', accepted_at: '2026-10-21T09:58:00Z' };
    const out2 = renderSessionContext({ ...base, handoffs: [recentElsewhere] }, [], { tip: () => '', t: zh, projectAliases: ['idaytour'], now });
    assert.doesNotMatch(out2, /Handoff/);
  });

  it('falls back to active_handoff from an older server, with the same rules', () => {
    const out = renderSessionContext({ ...base, active_handoff: { id: 3, project: 'OwnMind', content: '舊伺服器的交接' } }, [], { tip: () => '', t: zh, project: 'ownmind' });
    assert.match(out, /## Handoff to accept now \(#3\)/);
    assert.match(out, /舊伺服器的交接/);
    const elsewhere = renderSessionContext({ ...base, active_handoff: { id: 3, project: 'OwnMind', content: 'x' } }, [], { tip: () => '', t: zh, project: 'vinutes' });
    assert.match(elsewhere, /你有一筆 OwnMind 的交接還沒接/);
  });

  it('reads the Chinese lines from the locale dictionary, not from code', () => {
    const before = process.env.OWNMIND_LOCALE_FORCE;
    process.env.OWNMIND_LOCALE_FORCE = 'zh';
    try {
      const out = renderSessionContext({ ...base, handoffs: [pending] }, [], { tip: () => '', projectAliases: ['nantou-funbus'] });
      assert.match(out, /已接手 nantou-funbus 的交接，要撤銷跟我說一聲/);
    } finally {
      if (before === undefined) delete process.env.OWNMIND_LOCALE_FORCE; else process.env.OWNMIND_LOCALE_FORCE = before;
    }
  });

  it('a long handoff is capped and says so', () => {
    const content = Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 行`).join('\n');
    const out = renderSessionContext({ ...base, handoffs: [{ ...pending, content }] }, [], { tip: () => '', t: zh, projectAliases: ['nantou-funbus'] });
    assert.match(out, /第 80 行/);
    assert.doesNotMatch(out, /第 81 行\n/);
    assert.match(out, /40 more line\(s\) not shown/);
  });
});

describe('renderSessionContext — consolidation (v1.33.0)', () => {
  const zh = (key, p) => (key === 'consolidation.report'
    ? `[OwnMind] ${p.month} 的記憶整理完了：合併 ${p.merged}、歸檔 ${p.archived}、定案 ${p.decided}。要還原任何一條，說一聲。`
    : key);
  const base = { server_version: '1.33.0' };

  it('an open card is handed to a background subagent, not worked here', () => {
    const out = renderSessionContext({ ...base, consolidation: { card: { id: 40, title: '整理記憶 2026-10', status: 'open' }, report: null, questions: [] } }, [], { tip: () => '', t: zh });
    assert.match(out, /## Memory consolidation card #40 is open \(整理記憶 2026-10\)/);
    assert.match(out, /background subagent \(Agent tool\)/);
    assert.match(out, /ownmind_task_claim\(\{ id: 40 \}\)/);
    assert.match(out, /ownmind_consolidation_candidates/);
    assert.match(out, /`ownmind-consolidate` skill/);
    assert.doesNotMatch(out, /configs\/skills/);
  });

  it('a finished card renders the one-line report, exactly as the dictionary says it', () => {
    const out = renderSessionContext({ ...base, consolidation: { card: null, report: { task_id: 40, month: '2026-10', merged: 2, archived: 18, decided: 5 }, questions: [] } }, [], { tip: () => '', t: zh });
    assert.match(out, /## Memory consolidation report/);
    assert.match(out, /\[OwnMind\] 2026-10 的記憶整理完了：合併 2、歸檔 18、定案 5。要還原任何一條，說一聲。/);
    assert.match(out, /ownmind_restore/);
  });

  it('questions are listed, at most three, with how to record the answer', () => {
    const questions = Array.from({ length: 5 }, (_, i) => ({ id: 100 + i, memory_id: 500 + i, project: i ? 'vinutes' : null, question: `第 ${i + 1} 題？` }));
    const out = renderSessionContext({ ...base, consolidation: { card: null, report: null, questions } }, [], { tip: () => '', t: zh });
    assert.match(out, /## Questions for the person \(ask at a natural moment, at most 3\)/);
    assert.match(out, /- Q#100 about memory #500: 第 1 題？/);
    assert.match(out, /- Q#101 about memory #501, project vinutes: 第 2 題？/);
    assert.doesNotMatch(out, /第 4 題/);
    assert.match(out, /ownmind_decide/);
    assert.match(out, /ownmind_archive/);
  });

  it('nothing to say prints nothing', () => {
    for (const c of [undefined, null, {}, { card: null, report: null, questions: [] }, { card: { id: 1, status: 'done' } }]) {
      const out = renderSessionContext({ ...base, consolidation: c }, [], { tip: () => '', t: zh });
      assert.doesNotMatch(out, /consolidation/i, `consolidation=${JSON.stringify(c)} printed a section`);
      assert.doesNotMatch(out, /Questions for the person/);
    }
  });

  it('the lessons-waiting section and the never-review sentence are gone', () => {
    const out = renderSessionContext({ ...base, lessons_waiting: 7, tasks: { project: 'om', cards: [{ id: 1, title: 't', status: 'open' }] } }, [], { tip: () => '', t: zh });
    assert.doesNotMatch(out, /Lessons waiting/);
    assert.doesNotMatch(out, /inbox\/lessons/);
    assert.doesNotMatch(out, /Never mark one reviewed/);
    assert.match(out, /done needs evidence/);
  });
});
