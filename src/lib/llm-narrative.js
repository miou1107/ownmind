import { createHash } from 'node:crypto';

const SYSTEM_PROMPT = `你是 OwnMind 內部的數據敘事 agent。
輸入是一份團隊使用統計 JSON。請以「白話、不裝專業」風格產出 JSON，schema：
{
  "summary_one_line": "一句話結論",
  "section_explanations": {
    "ranking": "...", "versions": "...", "daily": "...", "hourly": "...",
    "weekday": "...", "event_types": "...", "compliance": "...",
    "update_health": "...", "project_ranking": "...", "project_compliance": "..."
  },
  "project_friction": { "<project_key>": ["踩坑短句", ...] },
  "insights_for_admin": ["洞察 1", "洞察 2", "洞察 3"],
  "next_actions": ["動作 1", "動作 2", "動作 3"]
}
規則：
- 只回 JSON、不加 markdown 圍欄、不加說明文字
- 「白話講」每段 1-3 句，避免術語
- project_friction 從 friction_raw 萃取，沒資料就回空陣列
- 對事不對人，不評論個人能力`;

export function buildMessages(narrativeData) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(narrativeData) },
  ];
}

export function parseLLMJson(raw) {
  let cleaned = String(raw).trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) cleaned = fenced[1].trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`LLM JSON parse failed: ${err.message}; raw=${String(raw).slice(0, 200)}`);
  }
}

export function computeDataHash(data) {
  return createHash('sha256').update(stableStringify(data)).digest('hex');
}

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

export async function callLLMSwitch({ apiKey, messages, fetchImpl = fetch, timeoutMs = 30_000 }) {
  if (!apiKey) throw new Error('LLM_SWITCH_API_KEY not set');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl('https://kkvin.com/llm-switch/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'auto',
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 2000,
        messages,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const txt = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
      throw new Error(`LLM upstream ${res.status}: ${String(txt).slice(0, 200)}`);
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content || '';
    return parseLLMJson(content);
  } finally {
    clearTimeout(timer);
  }
}
