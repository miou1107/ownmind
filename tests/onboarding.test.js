import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildOnboarding } from '../src/utils/onboarding.js';

describe('buildOnboarding', () => {
  it('無任何記憶 + 未完成 onboarding → 回傳 onboarding 物件', () => {
    const result = buildOnboarding({ hasAnyMemory: false, onboardingCompletedAt: null, tool: 'claude-code' });
    assert.ok(result);
    assert.strictEqual(result.is_new_user, true);
    assert.strictEqual(result.detected_tool, 'claude-code');
    assert.ok(typeof result.question === 'string' && result.question.length > 0);
  });

  it('有任何記憶（含 coding_standard / project 等）→ 回傳 null', () => {
    const result = buildOnboarding({ hasAnyMemory: true, onboardingCompletedAt: null, tool: 'claude-code' });
    assert.strictEqual(result, null);
  });

  it('已完成 onboarding（即使刪光記憶）→ 回傳 null', () => {
    const result = buildOnboarding({ hasAnyMemory: false, onboardingCompletedAt: '2026-04-23T10:00:00Z', tool: 'claude-code' });
    assert.strictEqual(result, null);
  });

  it('兩條件都滿足（有記憶且已完成）→ 回傳 null', () => {
    const result = buildOnboarding({ hasAnyMemory: true, onboardingCompletedAt: '2026-04-23T10:00:00Z', tool: 'claude-code' });
    assert.strictEqual(result, null);
  });

  it('tool 未傳入 → detected_tool 預設為 "AI 工具"', () => {
    const result = buildOnboarding({ hasAnyMemory: false, onboardingCompletedAt: null });
    assert.strictEqual(result.detected_tool, 'AI 工具');
  });
});
