import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildOnboarding } from '../src/utils/onboarding.js';

describe('buildOnboarding', () => {
  it('三項全空 → 回傳 onboarding 物件', () => {
    const result = buildOnboarding(null, [], [], 'claude-code');
    assert.ok(result);
    assert.strictEqual(result.is_new_user, true);
    assert.strictEqual(result.detected_tool, 'claude-code');
    assert.ok(typeof result.question === 'string' && result.question.length > 0);
  });

  it('有 profile → 回傳 null', () => {
    const result = buildOnboarding({ id: 1 }, [], [], 'claude-code');
    assert.strictEqual(result, null);
  });

  it('有 principles → 回傳 null', () => {
    const result = buildOnboarding(null, [{ id: 1 }], [], 'claude-code');
    assert.strictEqual(result, null);
  });

  it('有 iron_rules → 回傳 null', () => {
    const result = buildOnboarding(null, [], [{ id: 1 }], 'claude-code');
    assert.strictEqual(result, null);
  });

  it('tool 未傳入 → detected_tool 為 "AI 工具"', () => {
    const result = buildOnboarding(null, [], []);
    assert.strictEqual(result.detected_tool, 'AI 工具');
  });
});
