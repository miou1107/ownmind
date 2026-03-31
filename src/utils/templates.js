/**
 * Iron Rule Verification Templates
 *
 * 定義鐵律的自動化驗證模板，用於 pre-commit / pre-deploy 等 hook 檢查。
 * matchTemplate() 根據 rule 的 trigger tags + keywords 自動匹配最佳模板。
 */

const RULE_TEMPLATES = {
  commit_sync_docs: {
    name: 'Commit 前同步文件',
    match: {
      triggers: ['commit'],
      keywords: ['同步', 'README', 'CHANGELOG', 'FILELIST', '文件']
    },
    verification: {
      mode: 'pre_action',
      trigger: ['commit'],
      block_on_fail: true,
      compliance_event: null,
      conditions: {
        when: {
          type: 'source_files_changed',
          params: { patterns: ['src/**', 'mcp/**', 'hooks/**'] }
        },
        then: {
          type: 'staged_files_include',
          params: { patterns: ['README.md', 'CHANGELOG.md', 'FILELIST.md'] },
          message: '程式碼有改但 README/CHANGELOG/FILELIST 未同步'
        }
      }
    }
  },

  commit_no_secrets: {
    name: 'Commit 不含敏感檔案',
    match: {
      triggers: ['commit'],
      keywords: ['.env', '密碼', 'secret', 'credential', '敏感']
    },
    verification: {
      mode: 'pre_action',
      trigger: ['commit'],
      block_on_fail: true,
      compliance_event: null,
      conditions: {
        type: 'staged_files_exclude',
        params: { patterns: ['.env', '*.pem', '**/*.pem', '*.key', '**/*.key', 'credentials.*'] },
        message: 'staged 包含敏感檔案'
      }
    }
  },

  qa_three_steps: {
    name: '品管三步驟',
    match: {
      triggers: ['commit'],
      keywords: ['品管', '三步驟', 'review', 'verification', '品管三步驟']
    },
    verification: {
      mode: 'pre_action',
      trigger: ['commit'],
      block_on_fail: true,
      compliance_event: null,
      conditions: {
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
      }
    }
  },

  deploy_requires_test: {
    name: '部署前跑測試',
    match: {
      triggers: ['deploy'],
      keywords: ['測試', 'test', '部署前']
    },
    verification: {
      mode: 'pre_action',
      trigger: ['deploy'],
      block_on_fail: true,
      compliance_event: null,
      conditions: {
        type: 'recent_event_exists',
        params: { event: 'test-pass', action: 'comply' },
        message: '還沒跑測試'
      }
    }
  },

  commit_contributor: {
    name: 'Git contributor 控制',
    match: {
      triggers: ['commit'],
      keywords: ['contributor', 'Co-Authored', 'author', 'git contributor']
    },
    verification: {
      mode: 'pre_action',
      trigger: ['commit'],
      block_on_fail: true,
      compliance_event: null,
      conditions: {
        type: 'commit_message_not_contains',
        params: { patterns: ['Co-Authored-By'] },
        message: 'commit message 不能包含 Co-Authored-By'
      }
    }
  }
};

/**
 * 從 tags 陣列提取 trigger 名稱
 * @param {string[]|null} tags
 * @returns {string[]}
 */
function extractTriggers(tags) {
  if (!tags || !Array.isArray(tags)) return [];
  return tags
    .filter(t => t.startsWith('trigger:'))
    .map(t => t.replace('trigger:', ''));
}

/**
 * 根據 rule 的 trigger tags 與 content/title keywords 匹配最佳模板
 * @param {Object} rule - { title, content, tags }
 * @returns {string|null} 匹配的 template ID，無匹配回傳 null
 */
function matchTemplate(rule) {
  const triggers = extractTriggers(rule.tags);
  const content = (rule.title || '') + ' ' + (rule.content || '');
  const contentLower = content.toLowerCase();

  let bestMatch = null;
  let bestScore = 0;

  for (const [templateId, template] of Object.entries(RULE_TEMPLATES)) {
    // trigger 必須符合（至少一個交集）
    const triggerMatch = template.match.triggers.some(t => triggers.includes(t));
    if (!triggerMatch) continue;

    // keywords 計分
    const score = template.match.keywords.filter(kw =>
      contentLower.includes(kw.toLowerCase())
    ).length;

    if (score > 0 && score > bestScore) {
      bestScore = score;
      bestMatch = templateId;
    }
  }

  return bestMatch;
}

export { matchTemplate, extractTriggers, RULE_TEMPLATES };
