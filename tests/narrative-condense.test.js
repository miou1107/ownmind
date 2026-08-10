import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { condenseSections, REQUEST_BUDGET_BYTES } = await import('../src/lib/narrative-condense.js');

// Measured on production 2026-08-10: the upstream refuses a request body over roughly
// 40 KiB with 413, and every provider behind the switch refuses the same. The 7-day
// report is 32,372 bytes and goes through; 14-day is 47,893 and 30-day is 52,842, and
// both came back as 502 to the user, on every call. So the report existed for one of the
// three ranges the page offers.
//
// These tests are about what survives the shrinking, not just that it shrinks. A summary
// that drops the one project with a problem is worse than an error message.

const bytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

/** A sections payload shaped like the real one, sized by the knobs. */
function makeSections({ frictions = 60, frictionChars = 400, compliance = 50, versions = 44 } = {}) {
  return {
    ranking: [{ user_id: 1, name: 'A', turns: 10, measured: true }],
    versions: Array.from({ length: versions }, (_, i) => ({
      user_id: (i % 9) + 1,
      tool: ['claude-code', 'codex', 'cursor', 'antigravity', 'opencode'][i % 5],
      version: i % 7 === 0 ? '1.26.27' : '1.26.135',
      last_reported_at: `2026-08-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
      machine: `machine-${(i % 9) + 1}`,
    })),
    daily: [{ date: '2026-08-01', turns: 5 }],
    hourly: [{ hour: 9, turns: 3 }],
    weekday: [{ weekday: 1, turns: 4 }],
    event_types: [{ event: 'edit', count: 20 }],
    compliance: Array.from({ length: compliance }, (_, i) => ({
      user_id: (i % 9) + 1,
      user_name: `user-${(i % 9) + 1}`,
      rule_code: `R-${i}`,
      title: `規則 ${i} 的標題，寫得像真的一樣長一點`,
      comply: String(10 + i),
      skip: i % 10 === 0 ? '1' : '0',
      violate: i % 17 === 0 ? '2' : '0',
      observed: '0',
    })),
    update_health: [{ ok: 7, stale: 2 }],
    project_ranking: [{ project_key: 'p0', project: 'p0', user_id: 1, name: 'A', sessions: 3, turns: 9, tokens: '1' }],
    project_friction_raw: Array.from({ length: frictions }, (_, i) => ({
      project_key: `p${i % 6}`,
      friction: `專案 ${i} 的摩擦紀錄：`.padEnd(frictionChars, '這段是逐字記下來的踩坑描述，會很長。'),
    })),
    project_compliance: [],
  };
}

describe('condenseSections — when it should do nothing', () => {
  it('a payload already inside the budget is returned untouched', () => {
    const small = makeSections({ frictions: 3, frictionChars: 80, compliance: 4, versions: 5 });
    const r = condenseSections(small, { budgetBytes: 500_000 });
    assert.deepEqual(r.sections, small, 'the 7-day report must not change shape just because the code exists');
    assert.deepEqual(r.notes, []);
    assert.equal(r.fits, true);
  });

  it('does not mutate the input', () => {
    const src = makeSections();
    const before = JSON.stringify(src);
    condenseSections(src, { budgetBytes: 4_000 });
    assert.equal(JSON.stringify(src), before);
  });
});

describe('condenseSections — bringing an oversized payload inside the budget', () => {
  it('a 30-day-sized payload ends up under the budget', () => {
    const big = makeSections();
    assert.ok(bytes(big) > 40_000, 'the fixture must actually be too big, or this proves nothing');
    const r = condenseSections(big, { budgetBytes: 30_000 });
    assert.equal(r.fits, true);
    assert.ok(bytes(r.sections) <= 30_000, `still ${bytes(r.sections)} bytes`);
  });

  it('every project that had friction still has friction', () => {
    const big = makeSections();
    const before = new Set(big.project_friction_raw.map((f) => f.project_key));
    const r = condenseSections(big, { budgetBytes: 30_000 });
    const after = new Set(r.sections.project_friction_raw.map((f) => f.project_key));
    assert.deepEqual([...after].sort(), [...before].sort(),
      'dropping a whole project loses the only thing the friction section is for');
  });

  it('keeps every compliance row that has a violation or a skip', () => {
    const big = makeSections();
    const interesting = big.compliance.filter((c) => Number(c.violate) > 0 || Number(c.skip) > 0);
    assert.ok(interesting.length > 0);
    const r = condenseSections(big, { budgetBytes: 30_000 });
    const kept = new Set(r.sections.compliance.map((c) => c.rule_code));
    for (const c of interesting) {
      assert.ok(kept.has(c.rule_code), `dropped ${c.rule_code}, which had violate=${c.violate} skip=${c.skip}`);
    }
  });

  it('says how many clean compliance rows it left out, rather than silently shrinking', () => {
    const big = makeSections();
    const r = condenseSections(big, { budgetBytes: 30_000 });
    assert.ok(r.notes.some((n) => /compliance/.test(n)), `notes were ${JSON.stringify(r.notes)}`);
    assert.ok(r.sections._condensed, 'the model must be told it is reading a summary');
    assert.ok(Array.isArray(r.sections._condensed));
  });

  it('collapses the version list per machine and keeps the oldest version on it', () => {
    const big = makeSections();
    const r = condenseSections(big, { budgetBytes: 30_000 });
    const rows = r.sections.versions;
    const keys = rows.map((v) => `${v.user_id}::${v.machine}`);
    assert.equal(new Set(keys).size, keys.length, 'one row per machine');
    // A machine reporting 1.26.27 on one tool and 1.26.135 on another is a machine that is
    // behind. Keeping the newest would hide exactly the thing the section is read for.
    const behind = rows.filter((v) => v.version === '1.26.27');
    assert.ok(behind.length > 0, 'the stale version disappeared, which is the one that matters');
  });

  it('truncates long friction notes instead of deleting them', () => {
    const big = makeSections({ frictions: 60, frictionChars: 1200 });
    const r = condenseSections(big, { budgetBytes: 30_000 });
    assert.equal(r.sections.project_friction_raw.length, 60, 'entries kept, text shortened');
    for (const f of r.sections.project_friction_raw) {
      assert.ok(f.friction.length < 1200);
      assert.ok(f.friction.length > 0);
    }
  });
});

describe('condenseSections — running it twice', () => {
  it('condensing an already-condensed payload changes nothing further', () => {
    // The route can retry; a second pass that keeps eating the data would quietly hollow
    // the report out.
    const big = makeSections();
    const once = condenseSections(big, { budgetBytes: 30_000 });
    const twice = condenseSections(once.sections, { budgetBytes: 30_000 });
    assert.deepEqual(twice.sections, once.sections);
  });
});

describe('condenseSections — a section nobody planned for', () => {
  it('trims whatever the biggest list is, even one the targeted steps do not know about', () => {
    // The targeted steps aim at the three sections that were large on production. A section
    // that grows for some other reason would otherwise pass through all of them untouched,
    // come back over budget, and be sent anyway — which is the 502 this exists to stop.
    const big = makeSections({ frictions: 2, frictionChars: 40, compliance: 2, versions: 2 });
    big.project_ranking = Array.from({ length: 300 }, (_, i) => ({
      project_key: `p${i}`, project: `project-${i}`, user_id: 1, name: '一個名字',
      sessions: i, turns: i * 3, tokens: String(i * 1000),
    }));
    assert.ok(bytes(big) > 30_000);
    const r = condenseSections(big, { budgetBytes: 8_000 });
    assert.equal(r.fits, true);
    assert.ok(bytes(r.sections) <= 8_000);
    assert.ok(r.sections.project_ranking.length > 0, 'trimmed to nothing is not a summary');
    assert.ok(r.notes.some((n) => /project_ranking/.test(n)),
      `must say what it left out; notes were ${JSON.stringify(r.notes)}`);
  });
});

describe('condenseSections — when even one row does not fit', () => {
  it('reports fits=false rather than pretending', () => {
    const big = makeSections({ frictions: 400, frictionChars: 2000, compliance: 400, versions: 400 });
    const r = condenseSections(big, { budgetBytes: 200 });
    assert.equal(r.fits, false);
    assert.ok(r.notes.length > 0);
  });
});

describe('the budget itself', () => {
  it('sits below the measured 40 KiB ceiling with room for the envelope', () => {
    // 39,600 bytes went through and 41,025 came back 413, one request every 20 seconds so
    // rate limiting could not be read as a size limit.
    assert.ok(REQUEST_BUDGET_BYTES < 39_600, 'above a size that was measured to be refused');
    assert.ok(REQUEST_BUDGET_BYTES >= 36_000, 'less margin than this and the prompt cannot grow');
  });

  it('leaves the 7-day report alone at its real measured size', () => {
    // The three ranges measured 32,372 / 47,893 / 52,842 bytes on 2026-08-10. The 7-day
    // report is the one that has always worked; a budget under it would condense that
    // report for no reason and make today's output worse than before the fix.
    const SEVEN_DAY_BYTES = 32_372;
    assert.ok(REQUEST_BUDGET_BYTES > SEVEN_DAY_BYTES,
      `budget ${REQUEST_BUDGET_BYTES} would condense the 7-day report (${SEVEN_DAY_BYTES} bytes)`);
  });
});
