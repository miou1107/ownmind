import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { renderSessionContext } = await import('../hooks/lib/render-session-context.js');

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

  it('body longer than 400 chars is truncated to keep context from exploding', () => {
    const longBody = 'x'.repeat(1000);
    const out = renderSessionContext({ server_version: '1.17.0' }, [{
      title: '長廣播', body: longBody, severity: 'info'
    }]);
    // After 400-char truncation, the full 1000 chars must not be present.
    assert.ok(out.length < 2000, 'total output should not exceed 2000 chars');
  });

  it('multi-line body folds into 5 lines or fewer', () => {
    const multiline = Array.from({ length: 10 }, (_, i) => `Line ${i}`).join('\n');
    const out = renderSessionContext({ server_version: '1.17.0' }, [{
      title: '多行', body: multiline, severity: 'info'
    }]);
    // Only the first 5 lines are kept.
    assert.ok(out.includes('Line 4'));
    assert.ok(!out.includes('Line 5'));
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
    assert.match(out, /Project: ownmind/);
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
    const out = renderSessionContext({
      server_version: '1.26.128',
      team_standards_digest: '[團隊] 前端命名規範',
    }, []);
    assert.match(out, /standard_detail/);
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
