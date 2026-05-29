import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildOnboarding } from '../src/utils/onboarding.js';

describe('buildOnboarding', () => {
  it('no memory + onboarding not completed → returns onboarding object', () => {
    const result = buildOnboarding({ hasAnyMemory: false, onboardingCompletedAt: null, tool: 'claude-code' });
    assert.ok(result);
    assert.strictEqual(result.is_new_user, true);
    assert.strictEqual(result.detected_tool, 'claude-code');
    assert.ok(typeof result.question === 'string' && result.question.length > 0);
  });

  it('has any memory (including coding_standard / project, etc.) → returns null', () => {
    const result = buildOnboarding({ hasAnyMemory: true, onboardingCompletedAt: null, tool: 'claude-code' });
    assert.strictEqual(result, null);
  });

  it('onboarding already completed (even if all memory deleted) → returns null', () => {
    const result = buildOnboarding({ hasAnyMemory: false, onboardingCompletedAt: '2026-04-23T10:00:00Z', tool: 'claude-code' });
    assert.strictEqual(result, null);
  });

  it('both conditions met (has memory and completed) → returns null', () => {
    const result = buildOnboarding({ hasAnyMemory: true, onboardingCompletedAt: '2026-04-23T10:00:00Z', tool: 'claude-code' });
    assert.strictEqual(result, null);
  });

  it('tool not passed → detected_tool defaults to "AI 工具"', () => {
    const result = buildOnboarding({ hasAnyMemory: false, onboardingCompletedAt: null });
    assert.strictEqual(result.detected_tool, 'AI 工具');
  });
});
