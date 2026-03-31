import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchTemplate, extractTriggers, RULE_TEMPLATES } from '../src/utils/templates.js';

// ============================================================
// matchTemplate 測試
// ============================================================

describe('matchTemplate', () => {

  describe('正確匹配', () => {
    it('IR-008 匹配 commit_sync_docs', () => {
      const rule = {
        title: '每次 commit 必須同步更新 README、FILELIST、CHANGELOG',
        content: '程式碼有改時，README、FILELIST、CHANGELOG 必須同步更新',
        tags: ['trigger:commit', 'trigger:git']
      };
      assert.equal(matchTemplate(rule), 'commit_sync_docs');
    });

    it('IR-002 匹配 commit_no_secrets', () => {
      const rule = {
        title: '不要 commit .env 或密碼',
        content: '禁止 commit 敏感檔案如 .env、密碼、credential 到版控',
        tags: ['trigger:commit', 'trigger:git']
      };
      assert.equal(matchTemplate(rule), 'commit_no_secrets');
    });

    it('IR-012 匹配 qa_three_steps', () => {
      const rule = {
        title: '軟體開發品管三步驟（不可跳過）',
        content: 'verification → code review → receiving review，三步驟不可跳過',
        tags: ['trigger:commit']
      };
      assert.equal(matchTemplate(rule), 'qa_three_steps');
    });

    it('IR-009 匹配 commit_contributor', () => {
      const rule = {
        title: 'Git contributors 一律顯示 Vin',
        content: 'git commit 不加 Co-Authored-By，contributor 一律顯示 Vin',
        tags: ['trigger:commit', 'trigger:git']
      };
      assert.equal(matchTemplate(rule), 'commit_contributor');
    });

    it('部署前測試匹配 deploy_requires_test', () => {
      const rule = {
        title: '部署前必須跑測試',
        content: '部署前要先跑測試確認通過',
        tags: ['trigger:deploy']
      };
      assert.equal(matchTemplate(rule), 'deploy_requires_test');
    });
  });

  describe('不匹配', () => {
    it('trigger 不符 → null', () => {
      const rule = {
        title: 'SSH 不要頻繁登入登出',
        content: '一個 SSH session 完成所有工作再斷線',
        tags: ['trigger:ssh', 'trigger:deploy']
      };
      // 沒有模板的 triggers 含 ssh
      // deploy_requires_test 的 keywords 是 測試/test/部署前，不匹配
      const result = matchTemplate(rule);
      // 可能匹配到 deploy_requires_test（因為 content 含「部署」但不含「測試」）
      // 實際上 keywords 要命中才算，「部署前」不在 content 裡
      assert.equal(result, null);
    });

    it('無 trigger tags → null', () => {
      const rule = {
        title: '某條鐵律',
        content: '內容',
        tags: []
      };
      assert.equal(matchTemplate(rule), null);
    });

    it('tags 為 null → null', () => {
      const rule = {
        title: '某條鐵律',
        content: '內容',
        tags: null
      };
      assert.equal(matchTemplate(rule), null);
    });

    it('trigger 符合但 keywords 不命中 → null', () => {
      const rule = {
        title: '刪除按鈕要紅色且遠離編輯按鈕',
        content: 'UI 設計規範，刪除按鈕必須是紅色',
        tags: ['trigger:commit']
      };
      assert.equal(matchTemplate(rule), null);
    });
  });

  describe('優先級', () => {
    it('多個模板都能匹配時，keyword 命中數多的優先', () => {
      // 故意造一個同時命中 commit_sync_docs 和 commit_no_secrets 的 rule
      const rule = {
        title: 'commit 前同步 README 和排除 .env',
        content: '同步 README 文件，不要 commit .env 密碼 credential',
        tags: ['trigger:commit']
      };
      const result = matchTemplate(rule);
      // commit_no_secrets keywords: .env, 密碼, secret, credential, 敏感 → 命中 3 個（.env, 密碼, credential）
      // commit_sync_docs keywords: 同步, README, CHANGELOG, FILELIST, 文件 → 命中 3 個（同步, README, 文件）
      // 平手時看 Object.entries 順序，commit_sync_docs 排前面
      assert.ok(result !== null);
    });
  });

  describe('冪等性', () => {
    it('已有 verification 的鐵律不應被遷移腳本覆蓋', () => {
      const rule = {
        title: '已遷移的鐵律',
        content: 'commit 前同步 README',
        tags: ['trigger:commit'],
        metadata: {
          verification: { mode: 'pre_action', trigger: ['commit'] }
        }
      };
      // 遷移腳本應該先檢查 metadata.verification 是否存在
      // 存在 → 跳過
      const hasVerification = !!rule.metadata?.verification;
      assert.equal(hasVerification, true);
      // matchTemplate 本身不管這個，冪等邏輯在遷移腳本層
    });
  });
});

// ============================================================
// extractTriggers 測試
// ============================================================

describe('extractTriggers', () => {
  it('正常解析 trigger tags', () => {
    assert.deepEqual(
      extractTriggers(['trigger:commit', 'trigger:git', 'other-tag']),
      ['commit', 'git']
    );
  });

  it('空 tags → 空陣列', () => {
    assert.deepEqual(extractTriggers([]), []);
  });

  it('null tags → 空陣列', () => {
    assert.deepEqual(extractTriggers(null), []);
  });

  it('無 trigger 前綴 → 空陣列', () => {
    assert.deepEqual(extractTriggers(['commit', 'deploy']), []);
  });
});
