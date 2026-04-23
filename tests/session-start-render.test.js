import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { renderSessionContext } = await import('../hooks/lib/render-session-context.js');

describe('renderSessionContext — 廣播', () => {
  it('無廣播時輸出不含通知 section', () => {
    const out = renderSessionContext({ server_version: '1.17.0' }, []);
    assert.doesNotMatch(out, /系統通知/);
    assert.match(out, /OwnMind v1\.17\.0/);
  });

  it('廣播被放在最前面（memory 之前）', () => {
    const out = renderSessionContext(
      { server_version: '1.17.0' },
      [{ title: '維護通知', body: '週五晚 10pm', severity: 'warning' }]
    );
    const bcIdx = out.indexOf('系統通知');
    const memIdx = out.indexOf('記憶載入');
    assert.ok(bcIdx >= 0 && memIdx >= 0);
    assert.ok(bcIdx < memIdx, '廣播應在 memory 前');
  });

  it('render 升級提醒含 CTA + snooze hint', () => {
    const out = renderSessionContext({ server_version: '1.17.0' }, [{
      title: 'OwnMind 有新版本', body: '落後請升級',
      severity: 'warning', cta_text: '我要升級', cta_action: 'upgrade_ownmind',
      allow_snooze: true, snooze_hours: 24
    }]);
    assert.match(out, /我要升級/);
    assert.match(out, /讓 AI 幫你升級/);
    assert.match(out, /延後 24 小時/);
  });

  it('最多顯示 3 則廣播，其餘摘要', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      title: `廣播 ${i}`, body: 'x'.repeat(50), severity: 'info'
    }));
    const out = renderSessionContext({ server_version: '1.17.0' }, many);
    assert.ok(out.includes('廣播 0'));
    assert.ok(out.includes('廣播 2'));
    assert.ok(!out.includes('廣播 3'), '第 4 則不該渲染 body');
    assert.match(out, /另有 2 則廣播未顯示/);
  });

  it('body 超過 400 字會被截斷，避免 context 爆炸', () => {
    const longBody = 'x'.repeat(1000);
    const out = renderSessionContext({ server_version: '1.17.0' }, [{
      title: '長廣播', body: longBody, severity: 'info'
    }]);
    // 400 字截斷後應不含完整 1000 字
    assert.ok(out.length < 2000, '整段 output 不該超過 2000 字');
  });

  it('multi-line body 折疊成 5 行以內', () => {
    const multiline = Array.from({ length: 10 }, (_, i) => `Line ${i}`).join('\n');
    const out = renderSessionContext({ server_version: '1.17.0' }, [{
      title: '多行', body: multiline, severity: 'info'
    }]);
    // 只取前 5 行合併
    assert.ok(out.includes('Line 4'));
    assert.ok(!out.includes('Line 5'));
  });

  it('warning 等級廣播附加 SYSTEM 強制指令 block', () => {
    const out = renderSessionContext({ server_version: '1.17.0' }, [{
      title: '安全更新', body: '請盡快升級', severity: 'warning'
    }]);
    assert.match(out, /\[SYSTEM\] 強制行動要求/);
  });

  it('upgrade_reminder 類型廣播附加 SYSTEM 強制指令 block', () => {
    const out = renderSessionContext({ server_version: '1.17.0' }, [{
      title: 'OwnMind 有新版本', body: '請升級', severity: 'info', type: 'upgrade_reminder'
    }]);
    assert.match(out, /\[SYSTEM\] 強制行動要求/);
  });

  it('info 等級且非 upgrade_reminder 不附加強制指令', () => {
    const out = renderSessionContext({ server_version: '1.17.0' }, [{
      title: '一般公告', body: '系統維護', severity: 'info', type: 'announcement'
    }]);
    assert.doesNotMatch(out, /\[SYSTEM\] 強制行動要求/);
  });
});

describe('renderSessionContext — memory', () => {
  it('輸出 server_version 佔位符（data 無 version）', () => {
    const out = renderSessionContext({}, []);
    assert.match(out, /OwnMind v\?/);
  });

  it('顯示 profile / iron_rules_digest / principles / active_handoff', () => {
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
    assert.match(out, /專案: ownmind/);
  });

  it('missing sections 不 crash', () => {
    const out = renderSessionContext({}, []);
    assert.ok(out.length > 0);
    assert.match(out, /OwnMind/);
  });
});

describe('renderSessionContext — 結尾固定訊息', () => {
  it('結尾含 MCP tool hint', () => {
    const out = renderSessionContext({}, []);
    assert.match(out, /ownmind_\* MCP tools/);
  });
});
