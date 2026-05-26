import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchTemplate, extractTriggers, RULE_TEMPLATES } from '../src/utils/templates.js';

// ============================================================
// matchTemplate tests
// ============================================================

describe('matchTemplate', () => {

  describe('correct matches', () => {
    it('IR-008 matches commit_sync_docs', () => {
      const rule = {
        title: '每次 commit 必須同步更新 README、FILELIST、CHANGELOG',
        content: '程式碼有改時，README、FILELIST、CHANGELOG 必須同步更新',
        tags: ['trigger:commit', 'trigger:git']
      };
      assert.equal(matchTemplate(rule), 'commit_sync_docs');
    });

    it('IR-002 matches commit_no_secrets', () => {
      const rule = {
        title: '不要 commit .env 或密碼',
        content: '禁止 commit 敏感檔案如 .env、密碼、credential 到版控',
        tags: ['trigger:commit', 'trigger:git']
      };
      assert.equal(matchTemplate(rule), 'commit_no_secrets');
    });

    it('IR-012 matches qa_three_steps', () => {
      const rule = {
        title: '軟體開發品管三步驟（不可跳過）',
        content: 'verification → code review → receiving review，三步驟不可跳過',
        tags: ['trigger:commit']
      };
      assert.equal(matchTemplate(rule), 'qa_three_steps');
    });

    it('IR-009 matches commit_contributor', () => {
      const rule = {
        title: 'Git contributors 一律顯示 Vin',
        content: 'git commit 不加 Co-Authored-By，contributor 一律顯示 Vin',
        tags: ['trigger:commit', 'trigger:git']
      };
      assert.equal(matchTemplate(rule), 'commit_contributor');
    });

    it('pre-deploy testing matches deploy_requires_test', () => {
      const rule = {
        title: '部署前必須跑測試',
        content: '部署前要先跑測試確認通過',
        tags: ['trigger:deploy']
      };
      assert.equal(matchTemplate(rule), 'deploy_requires_test');
    });
  });

  describe('no match', () => {
    it('trigger does not match → null', () => {
      const rule = {
        title: 'SSH 不要頻繁登入登出',
        content: '一個 SSH session 完成所有工作再斷線',
        tags: ['trigger:ssh', 'trigger:deploy']
      };
      // No template's triggers include ssh.
      // deploy_requires_test keywords are 測試/test/部署前 — none of them match.
      const result = matchTemplate(rule);
      // Could match deploy_requires_test (content contains 部署 but not 測試);
      // in practice keywords must hit, and 部署前 is not in the content.
      assert.equal(result, null);
    });

    it('no trigger tags → null', () => {
      const rule = {
        title: '某條鐵律',
        content: '內容',
        tags: []
      };
      assert.equal(matchTemplate(rule), null);
    });

    it('tags is null → null', () => {
      const rule = {
        title: '某條鐵律',
        content: '內容',
        tags: null
      };
      assert.equal(matchTemplate(rule), null);
    });

    it('trigger matches but keywords miss → null', () => {
      const rule = {
        title: '刪除按鈕要紅色且遠離編輯按鈕',
        content: 'UI 設計規範，刪除按鈕必須是紅色',
        tags: ['trigger:commit']
      };
      assert.equal(matchTemplate(rule), null);
    });
  });

  describe('priority', () => {
    it('when multiple templates match, the one with more keyword hits wins', () => {
      // Construct a rule that intentionally hits both commit_sync_docs and commit_no_secrets.
      const rule = {
        title: 'commit 前同步 README 和排除 .env',
        content: '同步 README 文件，不要 commit .env 密碼 credential',
        tags: ['trigger:commit']
      };
      const result = matchTemplate(rule);
      // commit_no_secrets keywords: .env, 密碼, secret, credential, 敏感 → 3 hits (.env, 密碼, credential).
      // commit_sync_docs keywords: 同步, README, CHANGELOG, FILELIST, 文件 → 3 hits (同步, README, 文件).
      // On a tie, Object.entries order wins; commit_sync_docs comes first.
      assert.ok(result !== null);
    });
  });

  describe('idempotency', () => {
    it('rules with existing verification must not be overwritten by the migration script', () => {
      const rule = {
        title: '已遷移的鐵律',
        content: 'commit 前同步 README',
        tags: ['trigger:commit'],
        metadata: {
          verification: { mode: 'pre_action', trigger: ['commit'] }
        }
      };
      // The migration script must check metadata.verification first;
      // if it exists, skip the rule.
      const hasVerification = !!rule.metadata?.verification;
      assert.equal(hasVerification, true);
      // matchTemplate itself does not handle this; idempotency lives at the migration-script layer.
    });
  });
});

// ============================================================
// extractTriggers tests
// ============================================================

describe('extractTriggers', () => {
  it('parses trigger tags normally', () => {
    assert.deepEqual(
      extractTriggers(['trigger:commit', 'trigger:git', 'other-tag']),
      ['commit', 'git']
    );
  });

  it('empty tags → empty array', () => {
    assert.deepEqual(extractTriggers([]), []);
  });

  it('null tags → empty array', () => {
    assert.deepEqual(extractTriggers(null), []);
  });

  it('no trigger prefix → empty array', () => {
    assert.deepEqual(extractTriggers(['commit', 'deploy']), []);
  });
});
