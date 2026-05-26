import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateConditions, CHECK_HANDLERS } from '../shared/verification.js';

// ============================================================
// CHECK_HANDLERS 單元測試
// ============================================================

describe('CHECK_HANDLERS', () => {

  // --- staged_files_include ---

  describe('staged_files_include', () => {
    it('所有 pattern 都在 staged files 中 → true', () => {
      const ctx = { stagedFiles: ['README.md', 'CHANGELOG.md', 'src/index.js'] };
      const result = CHECK_HANDLERS.staged_files_include(
        { patterns: ['README.md', 'CHANGELOG.md'] }, ctx
      );
      assert.equal(result, true);
    });

    it('缺少一個 pattern → false', () => {
      const ctx = { stagedFiles: ['README.md', 'src/index.js'] };
      const result = CHECK_HANDLERS.staged_files_include(
        { patterns: ['README.md', 'CHANGELOG.md'] }, ctx
      );
      assert.equal(result, false);
    });

    it('支援 glob pattern', () => {
      const ctx = { stagedFiles: ['docs/guide.md', 'src/index.js'] };
      const result = CHECK_HANDLERS.staged_files_include(
        { patterns: ['docs/*.md'] }, ctx
      );
      assert.equal(result, true);
    });

    it('context 缺失 stagedFiles → true（跳過檢查）', () => {
      const result = CHECK_HANDLERS.staged_files_include(
        { patterns: ['README.md'] }, {}
      );
      assert.equal(result, true);
    });
  });

  // --- staged_files_exclude ---

  describe('staged_files_exclude', () => {
    it('staged files 不含排除 pattern → true', () => {
      const ctx = { stagedFiles: ['src/index.js', 'README.md'] };
      const result = CHECK_HANDLERS.staged_files_exclude(
        { patterns: ['.env', '*.pem'] }, ctx
      );
      assert.equal(result, true);
    });

    it('staged files 包含排除 pattern → false', () => {
      const ctx = { stagedFiles: ['src/index.js', '.env'] };
      const result = CHECK_HANDLERS.staged_files_exclude(
        { patterns: ['.env', '*.pem'] }, ctx
      );
      assert.equal(result, false);
    });

    it('支援 glob pattern 排除', () => {
      const ctx = { stagedFiles: ['certs/server.pem'] };
      const result = CHECK_HANDLERS.staged_files_exclude(
        { patterns: ['**/*.pem'] }, ctx
      );
      assert.equal(result, false);
    });

    it('context 缺失 → true', () => {
      const result = CHECK_HANDLERS.staged_files_exclude(
        { patterns: ['.env'] }, {}
      );
      assert.equal(result, true);
    });
  });

  // --- commit_message_contains ---

  describe('commit_message_contains', () => {
    it('commit message 包含指定文字 → true', () => {
      const ctx = { commitMessage: 'feat: add login page' };
      const result = CHECK_HANDLERS.commit_message_contains(
        { patterns: ['feat:', 'fix:'] }, ctx
      );
      assert.equal(result, true);
    });

    it('commit message 不包含任何指定文字 → false', () => {
      const ctx = { commitMessage: 'update something' };
      const result = CHECK_HANDLERS.commit_message_contains(
        { patterns: ['feat:', 'fix:'] }, ctx
      );
      assert.equal(result, false);
    });

    it('context 缺失 → true', () => {
      const result = CHECK_HANDLERS.commit_message_contains(
        { patterns: ['feat:'] }, {}
      );
      assert.equal(result, true);
    });
  });

  // --- commit_message_not_contains ---

  describe('commit_message_not_contains', () => {
    it('commit message 不含禁止文字 → true', () => {
      const ctx = { commitMessage: 'feat: add login page' };
      const result = CHECK_HANDLERS.commit_message_not_contains(
        { patterns: ['Co-Authored-By'] }, ctx
      );
      assert.equal(result, true);
    });

    it('commit message 包含禁止文字 → false', () => {
      const ctx = { commitMessage: 'feat: add login\n\nCo-Authored-By: Bot' };
      const result = CHECK_HANDLERS.commit_message_not_contains(
        { patterns: ['Co-Authored-By'] }, ctx
      );
      assert.equal(result, false);
    });

    it('context 缺失 → true', () => {
      const result = CHECK_HANDLERS.commit_message_not_contains(
        { patterns: ['Co-Authored-By'] }, {}
      );
      assert.equal(result, true);
    });
  });

  // --- recent_event_exists ---

  describe('recent_event_exists', () => {
    it('complianceEvents 中有匹配的事件 → true', () => {
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

    it('有事件但 action 不匹配 → false', () => {
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

    it('complianceEvents 為空 → false', () => {
      const ctx = { complianceEvents: [] };
      const result = CHECK_HANDLERS.recent_event_exists(
        { event: 'code-review', action: 'comply' }, ctx
      );
      assert.equal(result, false);
    });

    it('context 缺失 complianceEvents → true（跳過）', () => {
      const result = CHECK_HANDLERS.recent_event_exists(
        { event: 'code-review', action: 'comply' }, {}
      );
      assert.equal(result, true);
    });
  });

  // --- source_files_changed ---

  describe('source_files_changed', () => {
    it('有原始碼檔案匹配 pattern → true', () => {
      const ctx = { changedSourceFiles: ['src/routes/memory.js', 'src/utils/report.js'] };
      const result = CHECK_HANDLERS.source_files_changed(
        { patterns: ['src/**'] }, ctx
      );
      assert.equal(result, true);
    });

    it('無匹配 → false', () => {
      const ctx = { changedSourceFiles: ['docs/README.md'] };
      const result = CHECK_HANDLERS.source_files_changed(
        { patterns: ['src/**'] }, ctx
      );
      assert.equal(result, false);
    });

    it('context 缺失 changedSourceFiles → false（不是 true）', () => {
      const result = CHECK_HANDLERS.source_files_changed(
        { patterns: ['src/**'] }, {}
      );
      assert.equal(result, false);
    });

    it('changedSourceFiles 為空 → false', () => {
      const ctx = { changedSourceFiles: [] };
      const result = CHECK_HANDLERS.source_files_changed(
        { patterns: ['src/**'] }, ctx
      );
      assert.equal(result, false);
    });
  });
});

// ============================================================
// evaluateConditions 組合邏輯測試
// ============================================================

describe('evaluateConditions', () => {

  describe('單一條件', () => {
    it('通過 → pass: true, failures 空', () => {
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

    it('失敗 → pass: false, failures 含 message', () => {
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

    it('未知 check type → pass: true（安全跳過）', () => {
      const conditions = {
        type: 'unknown_check_type',
        params: {},
        message: '不應出現'
      };
      const result = evaluateConditions(conditions, {});
      assert.equal(result.pass, true);
    });
  });

  describe('AND 條件', () => {
    it('全部通過 → pass', () => {
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

    it('一個失敗 → fail，回傳該失敗的 message', () => {
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

    it('全部失敗 → fail，回傳所有 message', () => {
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

  describe('OR 條件', () => {
    it('任一通過 → pass', () => {
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

    it('全部失敗 → fail，回傳所有 message', () => {
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

  describe('巢狀條件', () => {
    it('AND 內含 OR：外層 AND 全過 → pass', () => {
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

    it('AND 內含 OR：OR 全失敗 → 外層 AND fail', () => {
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

  describe('when/then 條件式', () => {
    it('when 為 false → 整體 pass', () => {
      const conditions = {
        when: { type: 'source_files_changed', params: { patterns: ['src/**'] } },
        then: { type: 'staged_files_include', params: { patterns: ['README.md'] }, message: '缺 README' }
      };
      const ctx = { changedSourceFiles: [], stagedFiles: [] };
      const result = evaluateConditions(conditions, ctx);
      assert.equal(result.pass, true);
      assert.equal(result.failures.length, 0);
    });

    it('when 為 true + then 通過 → pass', () => {
      const conditions = {
        when: { type: 'source_files_changed', params: { patterns: ['src/**'] } },
        then: { type: 'staged_files_include', params: { patterns: ['README.md'] }, message: '缺 README' }
      };
      const ctx = { changedSourceFiles: ['src/index.js'], stagedFiles: ['src/index.js', 'README.md'] };
      const result = evaluateConditions(conditions, ctx);
      assert.equal(result.pass, true);
    });

    it('when 為 true + then 失敗 → fail', () => {
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

  describe('隱含 AND（無 operator）', () => {
    it('沒有明確指定 operator 時視為 AND', () => {
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
// IR-008 遷移場景測試
// ============================================================

// 注意：IR-008 使用 when/then 語意，不是 AND。見下方 when/then 測試。

describe('IR-008 正確語意：when/then 條件式檢查', () => {
  // 正確語意：如果有原始碼改動 → 文件必須同步
  // 用 when/then 表達
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

  it('沒有原始碼改動 → pass（條件不適用）', () => {
    const ctx = {
      changedSourceFiles: ['docs/guide.md'],
      stagedFiles: ['docs/guide.md']
    };
    const result = evaluateConditions(ir008Conditions, ctx);
    assert.equal(result.pass, true);
    assert.equal(result.failures.length, 0);
  });

  it('有原始碼改動且文件同步 → pass', () => {
    const ctx = {
      changedSourceFiles: ['src/routes/memory.js'],
      stagedFiles: ['src/routes/memory.js', 'README.md', 'CHANGELOG.md', 'FILELIST.md']
    };
    const result = evaluateConditions(ir008Conditions, ctx);
    assert.equal(result.pass, true);
  });

  it('有原始碼改動但文件未同步 → fail', () => {
    const ctx = {
      changedSourceFiles: ['src/routes/memory.js'],
      stagedFiles: ['src/routes/memory.js', 'README.md']
    };
    const result = evaluateConditions(ir008Conditions, ctx);
    assert.equal(result.pass, false);
    assert.ok(result.failures.some(f => f.includes('未同步')));
  });

  it('changedSourceFiles 為空 → pass（when 為 false）', () => {
    const ctx = {
      changedSourceFiles: [],
      stagedFiles: ['README.md']
    };
    const result = evaluateConditions(ir008Conditions, ctx);
    assert.equal(result.pass, true);
  });
});

// ============================================================
// IR-012 品管三步驟場景測試
// ============================================================

describe('IR-012 品管三步驟場景', () => {
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

  it('兩個步驟都完成 → pass', () => {
    const ctx = {
      complianceEvents: [
        { event: 'verification', action: 'comply', ts: '2026-03-31T10:00:00Z' },
        { event: 'code-review', action: 'comply', ts: '2026-03-31T10:05:00Z' }
      ]
    };
    const result = evaluateConditions(ir012Conditions, ctx);
    assert.equal(result.pass, true);
  });

  it('只做了 verification 沒做 code review → fail', () => {
    const ctx = {
      complianceEvents: [
        { event: 'verification', action: 'comply', ts: '2026-03-31T10:00:00Z' }
      ]
    };
    const result = evaluateConditions(ir012Conditions, ctx);
    assert.equal(result.pass, false);
    assert.equal(result.failures.length, 1);
    assert.ok(result.failures[0].startsWith('還沒做 code review'),
      `failure 開頭應為「還沒做 code review」：${result.failures[0]}`);
  });

  it('兩個都沒做 → fail，回傳兩個 message', () => {
    const ctx = { complianceEvents: [] };
    const result = evaluateConditions(ir012Conditions, ctx);
    assert.equal(result.pass, false);
    assert.equal(result.failures.length, 2);
  });

  it('有 code-review 但 action 是 violate → fail', () => {
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
      `failure 開頭應為「還沒做 code review」：${result.failures[0]}`);
  });
});

// ============================================================
// IR-002 不 commit .env 場景測試
// ============================================================

describe('IR-002 不 commit .env 場景', () => {
  const ir002Conditions = {
    type: 'staged_files_exclude',
    params: { patterns: ['.env', '*.pem', '**/*.pem', '*.key', '**/*.key', 'credentials.*'] },
    message: 'staged 包含敏感檔案'
  };

  it('沒有敏感檔案 → pass', () => {
    const ctx = { stagedFiles: ['src/index.js', 'README.md'] };
    const result = evaluateConditions(ir002Conditions, ctx);
    assert.equal(result.pass, true);
  });

  it('包含 .env → fail', () => {
    const ctx = { stagedFiles: ['src/index.js', '.env'] };
    const result = evaluateConditions(ir002Conditions, ctx);
    assert.equal(result.pass, false);
  });

  it('包含 .pem 檔案（子目錄） → fail', () => {
    const ctx = { stagedFiles: ['server.pem'] };
    const result = evaluateConditions(ir002Conditions, ctx);
    assert.equal(result.pass, false);
  });
});

// ============================================================
// IR-009 Git contributor 場景測試
// ============================================================

describe('IR-009 Git contributor 場景', () => {
  const ir009Conditions = {
    type: 'commit_message_not_contains',
    params: { patterns: ['Co-Authored-By'] },
    message: 'commit message 不能包含 Co-Authored-By'
  };

  it('正常 commit message → pass', () => {
    const ctx = { commitMessage: 'feat: add verification engine' };
    const result = evaluateConditions(ir009Conditions, ctx);
    assert.equal(result.pass, true);
  });

  it('包含 Co-Authored-By → fail', () => {
    const ctx = { commitMessage: 'feat: add something\n\nCo-Authored-By: Bot <bot@example.com>' };
    const result = evaluateConditions(ir009Conditions, ctx);
    assert.equal(result.pass, false);
  });
});

// ============================================================
// context 互補測試（git hook vs MCP 各自有不同 context）
// ============================================================

describe('context 互補行為', () => {
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

  it('git hook context（有 git，無 compliance）→ 只檢查 git 部分', () => {
    const ctx = { stagedFiles: ['README.md', 'src/index.js'] };
    // recent_event_exists 因為沒有 complianceEvents → return true（跳過）
    const result = evaluateConditions(mixedConditions, ctx);
    assert.equal(result.pass, true);
  });

  it('MCP context（有 compliance，無 git）→ 只檢查 compliance 部分', () => {
    const ctx = {
      complianceEvents: [
        { event: 'code-review', action: 'comply', ts: '2026-03-31T10:00:00Z' }
      ]
    };
    // staged_files_include 因為沒有 stagedFiles → return true（跳過）
    const result = evaluateConditions(mixedConditions, ctx);
    assert.equal(result.pass, true);
  });

  it('完整 context（兩者都有）→ 兩部分都檢查', () => {
    const ctx = {
      stagedFiles: ['src/index.js'],  // 缺 README
      complianceEvents: [
        { event: 'code-review', action: 'comply', ts: '2026-03-31T10:00:00Z' }
      ]
    };
    const result = evaluateConditions(mixedConditions, ctx);
    assert.equal(result.pass, false);
    assert.deepEqual(result.failures, ['缺 README，請 git add README.md 後重試']);
  });

  it('空 context → 全部跳過 → pass', () => {
    const result = evaluateConditions(mixedConditions, {});
    assert.equal(result.pass, true);
  });
});

// ============================================================
// v1.20.2 — recent_event_exists 失敗訊息含具體 ownmind_report_compliance 呼叫範例
// ============================================================

describe('v1.20.2 FIX_HINTS.recent_event_exists 具體呼叫範例', () => {
  it('verification 缺失 → hint 含 ownmind_report_compliance 呼叫範例 + rule_title verification + 不要帶 rule_code 提示', () => {
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
      `hint 開頭應為規則 message：${msg}`);
    assert.ok(msg.includes('ownmind_report_compliance'),
      `hint 應提及 ownmind_report_compliance：${msg}`);
    assert.ok(
      msg.includes("rule_title: 'verification'") || msg.includes('rule_title: "verification"'),
      `hint 應指明 rule_title: verification：${msg}`
    );
    assert.ok(
      msg.includes("action: 'comply'") || msg.includes('action: "comply"'),
      `hint 應指明 action: comply：${msg}`
    );
    assert.ok(
      msg.includes('rule_code') && /不要帶|不能填|別帶|不要填|無須|勿帶/.test(msg),
      `hint 應警告不要帶 rule_code：${msg}`
    );
  });

  it('code-review 缺失 → hint 含 rule_title: code-review', () => {
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
      `hint 應指明 rule_title: code-review：${msg}`
    );
  });

  it('條件通過時不產生 failures', () => {
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

  it('失敗訊息長度不超過 250 字（避免鉤子輸出爆版）', () => {
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

  it('Spec Scenario 4 守備：其他 CHECK_HANDLERS 的 hint 文字不受影響', () => {
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
    assert.ok(msg.startsWith('缺檔案'), `hint 開頭應為規則 message：${msg}`);
    assert.ok(msg.includes('git add'),
      `staged_files_include hint 應維持「請 git add ...」格式：${msg}`);
    assert.ok(!msg.includes('ownmind_report_compliance'),
      `staged_files_include hint 不應誤帶 ownmind_report_compliance：${msg}`);
  });

  it('params.event 內含單引號時、JSON.stringify 防護 hint 不會壞掉', () => {
    const conditions = {
      type: 'recent_event_exists',
      params: { event: "weird'name", action: 'comply' },
      message: '還沒做 weird'
    };
    const ctx = { complianceEvents: [] };
    const result = evaluateConditions(conditions, ctx);
    const msg = result.failures[0];
    // JSON.stringify("weird'name") = '"weird\'name"' → 雙引號包裹、單引號照原樣
    assert.ok(msg.includes('"weird\'name"'),
      `params.event 含單引號時應用雙引號包裹：${msg}`);
  });
});
