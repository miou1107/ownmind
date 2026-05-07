import { createHash } from 'node:crypto';

const SYSTEM_PROMPT = `你是 OwnMind 內部的資深數據分析師，要寫一份給管理者看的「整體分析報告」。
輸入是一份團隊使用統計 JSON，包含 ranking / versions / daily / hourly / weekday / event_types / compliance / update_health / project_ranking / project_friction_raw 這些 key。

產出 JSON：
{
  "summary_one_line": "一句話結論",
  "section_explanations": {
    "ranking": "...", "versions": "...", "daily": "...", "hourly": "...",
    "weekday": "...", "event_types": "...", "compliance": "...",
    "update_health": "...", "project_ranking": "..."
  },
  "project_friction": { "<project_key>": ["踩坑短句", ...] },
  "insights_for_admin": ["洞察 1", "洞察 2", "洞察 3"],
  "next_actions": ["動作 1", "動作 2", "動作 3"]
}

寫作規則（重要）：
1. 只回 JSON、不加 markdown 圍欄、不加說明文字
2. 「白話講」必須有觀點，不是讀表格。
   ✗ 廢話：「使用者排名，Vincent 排名第一」
   ✓ 觀點：「Vincent 一個人佔了 40% 工作量，第二名 Michelle 是潛在大使人選」
3. 「insights_for_admin」必須是具體判斷，找風險、找盲點、找 bus factor。
   ✗ 廢話：「使用者排名可以幫助管理員了解使用者行為」
   ✓ 具體：「funit-v2 全部 491 輪都是 Adam 一人扛，bus factor=1，他離職這專案會斷」
4. 「next_actions」必須是可執行的指令式動作，含對象。
   ✗ 廢話：「分析每日使用統計」
   ✓ 具體：「請 Eric 升級 OwnMind（他卡 v1.17.17 落後 5 版）」
5. project_friction 從 project_friction_raw 萃取「實質踩過的坑」，去重 + 用一句話濃縮，沒資料就回 {}
6. 對事不對人、不評論個人能力。但可以指出「某人扛太多」這類風險
7. 用繁體中文`;

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
