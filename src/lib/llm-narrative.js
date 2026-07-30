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
  "project_friction": {
    "<project_key>": [
      { "what": "發生了什麼（一句話）", "impact": "造成什麼影響", "mitigation": "怎麼改善" }
    ]
  },
  "insights_for_admin": ["洞察 1", "洞察 2", "洞察 3"],
  "next_actions": ["動作 1", "動作 2", "動作 3"]
}

寫作規則（重要）：
1. 只回 JSON、不加 markdown 圍欄、不加說明文字
2. 「白話講」必須有觀點，不是讀表格。寫法上要：給排名 + 給實際比例 + 把名次轉成「角色定位」。
   ✗ 廢話：「使用者排名，Alice 排名第一」
   ✓ 觀點：「第一名 Alice 一個人用了 40% 的 AI 工作量，第二名 Dana 也很常用，用了 25%，是在團隊中最常用 AI 完成工作的人」
3. 「insights_for_admin」必須是具體判斷，可以找盲點、找實際工作落差，但**不要對個人下風險評價**（離職假設、扛太多、接不下去都不寫）。提到高貢獻者時用正面肯定的語氣。
   ✗ 廢話：「使用者排名可以幫助管理員了解使用者行為」
   ✗ 個人風險：「exampleclient-v2 全部 491 輪都是 Bob 在做，他如果離職這個專案會接不下去」
   ✓ 具體 + 正面：「exampleclient-v2 全部 491 輪由 Bob 一個人完成，是這個專案最主要的開發者，貢獻極大、開發很認真」
4. 「next_actions」必須是可執行的指令式動作，含對象。
   ✗ 廢話：「分析每日使用統計」
   ✓ 具體：「請 Alice 升級 OwnMind（他卡 v1.17.17 落後 5 版）」
5. project_friction 從 project_friction_raw 萃取「實質踩過的坑」。每個專案抓 1–3 條，每條三段式：
   - what：發生了什麼（一句話）
   - impact：造成什麼影響（往「進度延誤、產品 bug、額外成本、認知偏差」這類具體影響推斷；沒明確證據時寫「影響不確定」，不要編）
   - mitigation：怎麼改善（具體可執行動作；原因不明時寫「需找 PM 釐清根因」）
   ✗ 不要寫：AI 自己的流程心得、skill 觸發紀錄、無代價的觀察
   ✓ 要寫：實際讓事情變慢／出錯／要重做的事
   去重後沒資料就回 {}
6. 對事不對人。報告會被被分析者看到，預設正面肯定 — 高貢獻者寫「主要開發者、貢獻極大、開發認真」這類肯定語氣，**禁止寫「某人扛太多」「某人離職就接不下去」「bus factor」這種把個人當風險的話**。事情層面的問題（例如進度落後、版本沒升）照寫，但不要把責任綁在個人身上。
7. 不要用行話 / 專業術語 / 行銷詞（例如「大使」「賦能」「對齊」「閉環」「bus factor」「分流」「扛」）。
   用團隊裡每個人都聽得懂的話。讀者可能是不懂技術的管理者。
8. 用繁體中文
9. ranking 裡 measured=false 代表「這個人從來沒有回報過任何資料」（可能還沒安裝），不是
   「他用得很少」。不要把這些人寫成低使用量、不要放進排名比較。
   反過來，measured=true 而這段期間數字是 0，就是真的 0（那段時間沒在用），照實寫。
   **不要自己數有幾個人沒有資料、也不要說排名完整或不完整。** 介面自己會用精確的數字講這件事；
   你數出來的數字只要錯一次，就是一句很有自信的假話。`;

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

export async function callLLMSwitch({ apiKey, messages, fetchImpl = fetch, timeoutMs = 30_000, apiBase = process.env.OWNMIND_LLM_API_BASE }) {
  if (!apiKey) throw new Error('LLM_SWITCH_API_KEY not set');
  if (!apiBase) throw new Error('OWNMIND_LLM_API_BASE not set (the OpenAI-compatible LLM endpoint base URL)');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${apiBase.replace(/\/+$/, '')}/chat/completions`, {
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
