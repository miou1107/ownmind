export function buildOnboarding({ hasAnyMemory, onboardingCompletedAt, tool = 'AI 工具' }) {
  const isNew = !hasAnyMemory && !onboardingCompletedAt;
  if (!isNew) return null;
  return {
    is_new_user: true,
    detected_tool: tool,
    question: '你好！我是 OwnMind，你的個人 AI 記憶系統。請問你叫什麼名字，主要做什麼工作？',
  };
}
