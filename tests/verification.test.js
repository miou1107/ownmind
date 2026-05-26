import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateConditions, CHECK_HANDLERS } from '../shared/verification.js';

// ============================================================
// CHECK_HANDLERS unit tests
// ============================================================

describe('CHECK_HANDLERS', () => {

  // --- staged_files_include ---

  describe('staged_files_include', () => {
    it('all patterns present in staged files → true', () => {
      const ctx = { stagedFiles: ['README.md', 'CHANGELOG.md', 'src/index.js'] };
      const result = CHECK_HANDLERS.staged_files_include(
        { patterns: ['README.md', 'CHANGELOG.md'] }, ctx
      );
      assert.equal(result, true);
    });

    it('one pattern missing → false', () => {
      const ctx = { stagedFiles: ['README.md', 'src/index.js'] };
      const result = CHECK_HANDLERS.staged_files_include(
        { patterns: ['README.md', 'CHANGELOG.md'] }, ctx
      );
      assert.equal(result, false);
    });

    it('supports glob patterns', () => {
      const ctx = { stagedFiles: ['docs/guide.md', 'src/index.js'] };
      const result = CHECK_HANDLERS.staged_files_include(
        { patterns: ['docs/*.md'] }, ctx
      );
      assert.equal(result, true);
    });

    it('context missing stagedFiles → true (skip check)', () => {
      const result = CHECK_HANDLERS.staged_files_include(
        { patterns: ['README.md'] }, {}
      );
      assert.equal(result, true);
    });
  });

  // --- staged_files_exclude ---

  describe('staged_files_exclude', () => {
    it('staged files do not contain excluded patterns → true', () => {
      const ctx = { stagedFiles: ['src/index.js', 'README.md'] };
      const result = CHECK_HANDLERS.staged_files_exclude(
        { patterns: ['.env', '*.pem'] }, ctx
      );
      assert.equal(result, true);
    });

    it('staged files contain an excluded pattern → false', () => {
      const ctx = { stagedFiles: ['src/index.js', '.env'] };
      const result = CHECK_HANDLERS.staged_files_exclude(
        { patterns: ['.env', '*.pem'] }, ctx
      );
      assert.equal(result, false);
    });

    it('supports glob pattern exclusion', () => {
      const ctx = { stagedFiles: ['certs/server.pem'] };
      const result = CHECK_HANDLERS.staged_files_exclude(
        { patterns: ['**/*.pem'] }, ctx
      );
      assert.equal(result, false);
    });

    it('context missing → true', () => {
      const result = CHECK_HANDLERS.staged_files_exclude(
        { patterns: ['.env'] }, {}
      );
      assert.equal(result, true);
    });
  });

  // --- commit_message_contains ---

  describe('commit_message_contains', () => {
    it('commit message contains one of the patterns → true', () => {
      const ctx = { commitMessage: 'feat: add login page' };
      const result = CHECK_HANDLERS.commit_message_contains(
        { patterns: ['feat:', 'fix:'] }, ctx
      );
      assert.equal(result, true);
    });

    it('commit message contains none of the patterns → false', () => {
      const ctx = { commitMessage: 'update something' };
      const result = CHECK_HANDLERS.commit_message_contains(
        { patterns: ['feat:', 'fix:'] }, ctx
      );
      assert.equal(result, false);
    });

    it('context missing → true', () => {
      const result = CHECK_HANDLERS.commit_message_contains(
        { patterns: ['feat:'] }, {}
      );
      assert.equal(result, true);
    });
  });

  // --- commit_message_not_contains ---

  describe('commit_message_not_contains', () => {
    it('commit message does not contain forbidden text → true', () => {
      const ctx = { commitMessage: 'feat: add login page' };
      const result = CHECK_HANDLERS.commit_message_not_contains(
        { patterns: ['Co-Authored-By'] }, ctx
      );
      assert.equal(result, true);
    });

    it('commit message contains forbidden text → false', () => {
      const ctx = { commitMessage: 'feat: add login\n\nCo-Authored-By: Bot' };
      const result = CHECK_HANDLERS.commit_message_not_contains(
        { patterns: ['Co-Authored-By'] }, ctx
      );
      assert.equal(result, false);
    });

    it('context missing → true', () => {
      const result = CHECK_HANDLERS.commit_message_not_contains(
        { patterns: ['Co-Authored-By'] }, {}
      );
      assert.equal(result, true);
    });
  });

  // --- recent_event_exists ---

  describe('recent_event_exists', () => {
    it('complianceEvents contains a matching event → true', () => {
      const ctx = {
        complianceEvents: [
          { event: 'verification', action: 'comply', ts: '2026-03-31T10:00:00Z' },
          { event: 'code-review', action: 'comply', ts: '2026-03-31T10:05:00Z' }
        ]
      };
      const result = CHECK_HANDLERS.recent_event_exists(
        { event: 'code-review', action: 'comply' }, ctx
      );
      assert.equal(result, true);
    });

    it('event exists but action does not match → false', () => {
      const ctx = {
        complianceEvents: [
          { event: 'code-review', action: 'violate', ts: '2026-03-31T10:00:00Z' }
        ]
      };
      const result = CHECK_HANDLERS.recent_event_exists(
        { event: 'code-review', action: 'comply' }, ctx
      );
      assert.equal(result, false);
    });

    it('complianceEvents is empty → false', () => {
      const ctx = { complianceEvents: [] };
      const result = CHECK_HANDLERS.recent_event_exists(
        { event: 'code-review', action: 'comply' }, ctx
      );
      assert.equal(result, false);
    });

    it('context missing complianceEvents → true (skip)', () => {
      const result = CHECK_HANDLERS.recent_event_exists(
        { event: 'code-review', action: 'comply' }, {}
      );
      assert.equal(result, true);
    });
  });

  // --- source_files_changed ---

  describe('source_files_changed', () => {
    it('source files match a pattern → true', () => {
      const ctx = { changedSourceFiles: ['src/routes/memory.js', 'src/utils/report.js'] };
      const result = CHECK_HANDLERS.source_files_changed(
        { patterns: ['src/**'] }, ctx
      );
      assert.equal(result, true);
    });

    it('no match → false', () => {
      const ctx = { changedSourceFiles: ['docs/README.md'] };
      const result = CHECK_HANDLERS.source_files_changed(
        { patterns: ['src/**'] }, ctx
      );
      assert.equal(result, false);
    });

    it('context missing changedSourceFiles → false (not true)', () => {
      const result = CHECK_HANDLERS.source_files_changed(
        { patterns: ['src/**'] }, {}
      );
      assert.equal(result, false);
    });

    it('changedSourceFiles is empty → false', () => {
      const ctx = { changedSourceFiles: [] };
      const result = CHECK_HANDLERS.source_files_changed(
        { patterns: ['src/**'] }, ctx
      );
      assert.equal(result, false);
    });
  });
});

// ============================================================
// evaluateConditions composition tests
// ============================================================

describe('evaluateConditions', () => {

  describe('single condition', () => {
    it('pass → pass: true, failures empty', () => {
      const conditions = {
        type: 'staged_files_include',
        params: { patterns: ['README.md'] },
        message: '缺少 README'
      };
      const ctx = { stagedFiles: ['README.md', 'src/index.js'] };
      const result = evaluateConditions(conditions, ctx);
      assert.equal(result.pass, true);
      assert.equal(result.failures.length, 0);
    });

    it('fail → pass: false, failures contains message', () => {
      const conditions = {
        type: 'staged_files_include',
        params: { patterns: ['README.md'] },
        message: '缺少 README'
      };
      const ctx = { stagedFiles: ['src/index.js'] };
      const result = evaluateConditions(conditions, ctx);
      assert.equal(result.pass, false);
      assert.deepEqual(result.failures, ['缺少 README，請 git add README.md 後重試']);
    });

    it('unknown check type → pass: true (safe skip)', () => {
      const conditions = {
        type: 'unknown_check_type',
        params: {},
        message: '不應出現'
      };
      const result = evaluateConditions(conditions, {});
      assert.equal(result.pass, true);
    });
  });

  describe('AND condition', () => {
    it('all pass → pass', () => {
      const conditions = {
        operator: 'AND',
        checks: [
          { type: 'staged_files_include', params: { patterns: ['README.md'] }, message: 'A' },
          { type: 'staged_files_include', params: { patterns: ['CHANGELOG.md'] }, message: 'B' }
        ]
      };
      const ctx = { stagedFiles: ['README.md', 'CHANGELOG.md'] };
      const result = evaluateConditions(conditions, ctx);
      assert.equal(result.pass, true);
      assert.equal(result.failures.length, 0);
    });

    it('one fails → fail, returns that failure message', () => {
      const conditions = {
        operator: 'AND',
        checks: [
          { type: 'staged_files_include', params: { patterns: ['README.md'] }, message: '缺 README' },
          { type: 'staged_files_include', params: { patterns: ['CHANGELOG.md'] }, message: '缺 CHANGELOG' }
        ]
      };
      const ctx = { stagedFiles: ['README.md'] };
      const result = evaluateConditions(conditions, ctx);
      assert.equal(result.pass, false);
      assert.deepEqual(result.failures, ['缺 CHANGELOG，請 git add CHANGELOG.md 後重試']);
    });

    it('all fail → fail, returns all messages', () => {
      const conditions = {
        operator: 'AND',
        checks: [
          { type: 'staged_files_include', params: { patterns: ['README.md'] }, message: '缺 README' },
          { type: 'staged_files_include', params: { patterns: ['CHANGELOG.md'] }, message: '缺 CHANGELOG' }
        ]
      };
      const ctx = { stagedFiles: ['src/index.js'] };
      const result = evaluateConditions(conditions, ctx);
      assert.equal(result.pass, false);
      assert.equal(result.failures.length, 2);
    });
  });

  describe('OR condition', () => {
    it('any pass → pass', () => {
      const conditions = {
        operator: 'OR',
        checks: [
          { type: 'staged_files_include', params: { patterns: ['README.md'] }, message: 'A' },
          { type: 'staged_files_include', params: { patterns: ['CHANGELOG.md'] }, message: 'B' }
        ]
      };
      const ctx = { stagedFiles: ['CHANGELOG.md'] };
      const result = evaluateConditions(conditions, ctx);
      assert.equal(result.pass, true);
      assert.equal(result.failures.length, 0);
    });

    it('all fail → fail, returns all messages', () => {
      const conditions = {
        operator: 'OR',
        checks: [
          { type: 'staged_files_include', params: { patterns: ['README.md'] }, message: '缺 README' },
          { type: 'staged_files_include', params: { patterns: ['CHANGELOG.md'] }, message: '缺 CHANGELOG' }
        ]
      };
      const ctx = { stagedFiles: ['src/index.js'] };
      const result = evaluateConditions(conditions, ctx);
      assert.equal(result.pass, false);
      assert.equal(result.failures.length, 2);
    });
  });

  describe('nested conditions', () => {
    it('AND containing OR: outer AND passes → pass', () => {
      const conditions = {
        operator: 'AND',
        checks: [
          { type: 'staged_files_include', params: { patterns: ['README.md'] }, message: '缺 README' },
          {
            operator: 'OR',
            checks: [
              { type: 'commit_message_contains', params: { patterns: ['feat:'] }, message: '需要 feat:' },
              { type: 'commit_message_contains', params: { patterns: ['fix:'] }, message: '需要 fix:' }
            ]
          }
        ]
      };
      const ctx = { stagedFiles: ['README.md'], commitMessage: 'fix: bug' };
      const result = evaluateConditions(conditions, ctx);
      assert.equal(result.pass, true);
    });

    it('AND containing OR: OR all fail → outer AND fails', () => {
      const conditions = {
        operator: 'AND',
        checks: [
          { type: 'staged_files_include', params: { patterns: ['README.md'] }, message: '缺 README' },
          {
            operator: 'OR',
            checks: [
              { type: 'commit_message_contains', params: { patterns: ['feat:'] }, message: '需要 feat:' },
              { type: 'commit_message_contains', params: { patterns: ['fix:'] }, message: '需要 fix:' }
            ]
          }
        ]
      };
      const ctx = { stagedFiles: ['README.md'], commitMessage: 'update something' };
      const result = evaluateConditions(conditions, ctx);
      assert.equal(result.pass, false);
      assert.ok(result.failures.some(f => f.startsWith('需要 feat:')));
      assert.ok(result.failures.some(f => f.startsWith('需要 fix:')));
    });
  });

  describe('when/then conditional', () => {
    it('when is false → overall pass', () => {
      const conditions = {
        when: { type: 'source_files_changed', params: { patterns: ['src/**'] } },
        then: { type: 'staged_files_include', params: { patterns: ['README.md'] }, message: '缺 README' }
      };
      const ctx = { changedSourceFiles: [], stagedFiles: [] };
      const result = evaluateConditions(conditions, ctx);
      assert.equal(result.pass, true);
      assert.equal(result.failures.length, 0);
    });

    it('when is true + then passes → pass', () => {
      const conditions = {
        when: { type: 'source_files_changed', params: { patterns: ['src/**'] } },
        then: { type: 'staged_files_include', params: { patterns: ['README.md'] }, message: '缺 README' }
      };
      const ctx = { changedSourceFiles: ['src/index.js'], stagedFiles: ['src/index.js', 'README.md'] };
      const result = evaluateConditions(conditions, ctx);
      assert.equal(result.pass, true);
    });

    it('when is true + then fails → fail', () => {
      const conditions = {
        when: { type: 'source_files_changed', params: { patterns: ['src/**'] } },
        then: { type: 'staged_files_include', params: { patterns: ['README.md'] }, message: '缺 README' }
      };
      const ctx = { changedSourceFiles: ['src/index.js'], stagedFiles: ['src/index.js'] };
      const result = evaluateConditions(conditions, ctx);
      assert.equal(result.pass, false);
      assert.deepEqual(result.failures, ['缺 README，請 git add README.md 後重試']);
    });
  });

  describe('implicit AND (no operator)', () => {
    it('no explicit operator is treated as AND', () => {
      const conditions = {
        checks: [
          { type: 'staged_files_include', params: { patterns: ['README.md'] }, message: 'A' },
          { type: 'staged_files_include', params: { patterns: ['CHANGELOG.md'] }, message: 'B' }
        ]
      };
      const ctx = { stagedFiles: ['README.md'] };
      const result = evaluateConditions(conditions, ctx);
      assert.equal(result.pass, false);
      assert.deepEqual(result.failures, ['B，請 git add CHANGELOG.md 後重試']);
    });
  });
});

// ============================================================
// IR-008 migration scenarios
// ============================================================

// Note: IR-008 uses when/then semantics, not AND. See when/then tests below.

describe('IR-008 correct semantics: when/then conditional check', () => {
  // Correct semantics: if source code changed → docs must be synced.
  // Expressed via when/then.
  const ir008Conditions = {
    when: {
      type: 'source_files_changed',
      params: { patterns: ['src/**', 'mcp/**', 'hooks/**'] }
    },
    then: {
      type: 'staged_files_include',
      params: { patterns: ['README.md', 'CHANGELOG.md', 'FILELIST.md'] },
      message: '程式碼有改但 README/CHANGELOG/FILELIST 未同步'
    }
  };

  it('no source code changes → pass (condition not applicable)', () => {
    const ctx = {
      changedSourceFiles: ['docs/guide.md'],
      stagedFiles: ['docs/guide.md']
    };
    const result = evaluateConditions(ir008Conditions, ctx);
    assert.equal(result.pass, true);
    assert.equal(result.failures.length, 0);
  });

  it('source code changes + docs synced → pass', () => {
    const ctx = {
      changedSourceFiles: ['src/routes/memory.js'],
      stagedFiles: ['src/routes/memory.js', 'README.md', 'CHANGELOG.md', 'FILELIST.md']
    };
    const result = evaluateConditions(ir008Conditions, ctx);
    assert.equal(result.pass, true);
  });

  it('source code changes + docs not synced → fail', () => {
    const ctx = {
      changedSourceFiles: ['src/routes/memory.js'],
      stagedFiles: ['src/routes/memory.js', 'README.md']
    };
    const result = evaluateConditions(ir008Conditions, ctx);
    assert.equal(result.pass, false);
    assert.ok(result.failures.some(f => f.includes('未同步')));
  });

  it('changedSourceFiles empty → pass (when is false)', () => {
    const ctx = {
      changedSourceFiles: [],
      stagedFiles: ['README.md']
    };
    const result = evaluateConditions(ir008Conditions, ctx);
    assert.equal(result.pass, true);
  });
});

// ============================================================
// IR-012 quality-control three-step scenario
// ============================================================

describe('IR-012 quality-control three-step scenario', () => {
  const ir012Conditions = {
    operator: 'AND',
    checks: [
      {
        type: 'recent_event_exists',
        params: { event: 'verification', action: 'comply' },
        message: '還沒做 verification'
      },
      {
        type: 'recent_event_exists',
        params: { event: 'code-review', action: 'comply' },
        message: '還沒做 code review'
      }
    ]
  };

  it('both steps completed → pass', () => {
    const ctx = {
      complianceEvents: [
        { event: 'verification', action: 'comply', ts: '2026-03-31T10:00:00Z' },
        { event: 'code-review', action: 'comply', ts: '2026-03-31T10:05:00Z' }
      ]
    };
    const result = evaluateConditions(ir012Conditions, ctx);
    assert.equal(result.pass, true);
  });

  it('verification done but code review missing → fail', () => {
    const ctx = {
      complianceEvents: [
        { event: 'verification', action: 'comply', ts: '2026-03-31T10:00:00Z' }
      ]
    };
    const result = evaluateConditions(ir012Conditions, ctx);
    assert.equal(result.pass, false);
    assert.equal(result.failures.length, 1);
    assert.ok(result.failures[0].startsWith('還沒做 code review'),
      `failure should start with "還沒做 code review": ${result.failures[0]}`);
  });

  it('neither step done → fail, returns both messages', () => {
    const ctx = { complianceEvents: [] };
    const result = evaluateConditions(ir012Conditions, ctx);
    assert.equal(result.pass, false);
    assert.equal(result.failures.length, 2);
  });

  it('code-review exists but action is violate → fail', () => {
    const ctx = {
      complianceEvents: [
        { event: 'verification', action: 'comply', ts: '2026-03-31T10:00:00Z' },
        { event: 'code-review', action: 'violate', ts: '2026-03-31T10:05:00Z' }
      ]
    };
    const result = evaluateConditions(ir012Conditions, ctx);
    assert.equal(result.pass, false);
    assert.equal(result.failures.length, 1);
    assert.ok(result.failures[0].startsWith('還沒做 code review'),
      `failure should start with "還沒做 code review": ${result.failures[0]}`);
  });
});

// ============================================================
// IR-002 do not commit .env scenario
// ============================================================

describe('IR-002 do not commit .env scenario', () => {
  const ir002Conditions = {
    type: 'staged_files_exclude',
    params: { patterns: ['.env', '*.pem', '**/*.pem', '*.key', '**/*.key', 'credentials.*'] },
    message: 'staged 包含敏感檔案'
  };

  it('no sensitive files → pass', () => {
    const ctx = { stagedFiles: ['src/index.js', 'README.md'] };
    const result = evaluateConditions(ir002Conditions, ctx);
    assert.equal(result.pass, true);
  });

  it('contains .env → fail', () => {
    const ctx = { stagedFiles: ['src/index.js', '.env'] };
    const result = evaluateConditions(ir002Conditions, ctx);
    assert.equal(result.pass, false);
  });

  it('contains a .pem file (subdirectory) → fail', () => {
    const ctx = { stagedFiles: ['server.pem'] };
    const result = evaluateConditions(ir002Conditions, ctx);
    assert.equal(result.pass, false);
  });
});

// ============================================================
// IR-009 Git contributor scenario
// ============================================================

describe('IR-009 Git contributor scenario', () => {
  const ir009Conditions = {
    type: 'commit_message_not_contains',
    params: { patterns: ['Co-Authored-By'] },
    message: 'commit message 不能包含 Co-Authored-By'
  };

  it('normal commit message → pass', () => {
    const ctx = { commitMessage: 'feat: add verification engine' };
    const result = evaluateConditions(ir009Conditions, ctx);
    assert.equal(result.pass, true);
  });

  it('contains Co-Authored-By → fail', () => {
    const ctx = { commitMessage: 'feat: add something\n\nCo-Authored-By: Bot <bot@example.com>' };
    const result = evaluateConditions(ir009Conditions, ctx);
    assert.equal(result.pass, false);
  });
});

// ============================================================
// Context complementarity (git hook vs MCP each have different context)
// ============================================================

describe('context complementarity behavior', () => {
  const mixedConditions = {
    operator: 'AND',
    checks: [
      {
        type: 'staged_files_include',
        params: { patterns: ['README.md'] },
        message: '缺 README'
      },
      {
        type: 'recent_event_exists',
        params: { event: 'code-review', action: 'comply' },
        message: '沒做 code review'
      }
    ]
  };

  it('git hook context (git present, no compliance) → only checks git portion', () => {
    const ctx = { stagedFiles: ['README.md', 'src/index.js'] };
    // recent_event_exists returns true (skipped) because complianceEvents missing.
    const result = evaluateConditions(mixedConditions, ctx);
    assert.equal(result.pass, true);
  });

  it('MCP context (compliance present, no git) → only checks compliance portion', () => {
    const ctx = {
      complianceEvents: [
        { event: 'code-review', action: 'comply', ts: '2026-03-31T10:00:00Z' }
      ]
    };
    // staged_files_include returns true (skipped) because stagedFiles missing.
    const result = evaluateConditions(mixedConditions, ctx);
    assert.equal(result.pass, true);
  });

  it('full context (both present) → both portions checked', () => {
    const ctx = {
      stagedFiles: ['src/index.js'],  // README missing
      complianceEvents: [
        { event: 'code-review', action: 'comply', ts: '2026-03-31T10:00:00Z' }
      ]
    };
    const result = evaluateConditions(mixedConditions, ctx);
    assert.equal(result.pass, false);
    assert.deepEqual(result.failures, ['缺 README，請 git add README.md 後重試']);
  });

  it('empty context → all skipped → pass', () => {
    const result = evaluateConditions(mixedConditions, {});
    assert.equal(result.pass, true);
  });
});

// ============================================================
// v1.20.2 — recent_event_exists failure message includes a concrete
// ownmind_report_compliance call example
// ============================================================

describe('v1.20.2 FIX_HINTS.recent_event_exists concrete call example', () => {
  it('verification missing → hint includes ownmind_report_compliance call example + rule_title verification + "do not pass rule_code" warning', () => {
    const conditions = {
      type: 'recent_event_exists',
      params: { event: 'verification', action: 'comply' },
      message: '還沒做 verification'
    };
    const ctx = { complianceEvents: [] };
    const result = evaluateConditions(conditions, ctx);
    assert.equal(result.pass, false);
    assert.equal(result.failures.length, 1);
    const msg = result.failures[0];
    assert.ok(msg.startsWith('還沒做 verification'),
      `hint should start with the rule message: ${msg}`);
    assert.ok(msg.includes('ownmind_report_compliance'),
      `hint should mention ownmind_report_compliance: ${msg}`);
    assert.ok(
      msg.includes("rule_title: 'verification'") || msg.includes('rule_title: "verification"'),
      `hint should specify rule_title: verification: ${msg}`
    );
    assert.ok(
      msg.includes("action: 'comply'") || msg.includes('action: "comply"'),
      `hint should specify action: comply: ${msg}`
    );
    assert.ok(
      msg.includes('rule_code') && /不要帶|不能填|別帶|不要填|無須|勿帶/.test(msg),
      `hint should warn not to pass rule_code: ${msg}`
    );
  });

  it('code-review missing → hint includes rule_title: code-review', () => {
    const conditions = {
      type: 'recent_event_exists',
      params: { event: 'code-review', action: 'comply' },
      message: '還沒做 code review'
    };
    const ctx = { complianceEvents: [] };
    const result = evaluateConditions(conditions, ctx);
    assert.equal(result.pass, false);
    const msg = result.failures[0];
    assert.ok(
      msg.includes("rule_title: 'code-review'") || msg.includes('rule_title: "code-review"'),
      `hint should specify rule_title: code-review: ${msg}`
    );
  });

  it('condition passes → no failures produced', () => {
    const conditions = {
      type: 'recent_event_exists',
      params: { event: 'verification', action: 'comply' },
      message: '還沒做 verification'
    };
    const ctx = {
      complianceEvents: [
        { event: 'verification', action: 'comply', ts: '2026-03-31T10:00:00Z' }
      ]
    };
    const result = evaluateConditions(conditions, ctx);
    assert.equal(result.pass, true);
    assert.deepEqual(result.failures, []);
  });

  it('failure message stays under 250 chars (keep hook output readable)', () => {
    const conditions = {
      type: 'recent_event_exists',
      params: { event: 'code-review', action: 'comply' },
      message: '還沒做 code review'
    };
    const ctx = { complianceEvents: [] };
    const result = evaluateConditions(conditions, ctx);
    assert.ok(
      result.failures[0].length <= 250,
      `failure msg too long: ${result.failures[0].length} chars`
    );
  });

  it('Spec Scenario 4 guard: hint text from other CHECK_HANDLERS is unchanged', () => {
    const stagedConditions = {
      type: 'staged_files_include',
      params: { patterns: ['README.md', 'CHANGELOG.md'] },
      message: '缺檔案'
    };
    const ctx = { stagedFiles: ['src/index.js'] };
    const result = evaluateConditions(stagedConditions, ctx);
    assert.equal(result.pass, false);
    assert.equal(result.failures.length, 1);
    const msg = result.failures[0];
    assert.ok(msg.startsWith('缺檔案'), `hint should start with the rule message: ${msg}`);
    assert.ok(msg.includes('git add'),
      `staged_files_include hint should preserve the "請 git add ..." format: ${msg}`);
    assert.ok(!msg.includes('ownmind_report_compliance'),
      `staged_files_include hint should not leak ownmind_report_compliance: ${msg}`);
  });

  it('when params.event contains a single quote, JSON.stringify guard keeps hint intact', () => {
    const conditions = {
      type: 'recent_event_exists',
      params: { event: "weird'name", action: 'comply' },
      message: '還沒做 weird'
    };
    const ctx = { complianceEvents: [] };
    const result = evaluateConditions(conditions, ctx);
    const msg = result.failures[0];
    // JSON.stringify("weird'name") = '"weird\'name"' — double quotes wrap, single quote stays as-is.
    assert.ok(msg.includes('"weird\'name"'),
      `params.event with a single quote should be wrapped in double quotes: ${msg}`);
  });
});
