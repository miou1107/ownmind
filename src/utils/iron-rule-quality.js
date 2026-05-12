/**
 * lintIronRule — 鐵律品質檢查（程式邏輯卡控、IR-027 落地）
 *
 * 為什麼存在：
 *   Vin 反饋的核心問題 — 鐵律寫進 OwnMind 之後、未來新 session 的 AI 看到
 *   要能 (1) 知道何時觸發、(2) 知道規則內容。不然鐵律形同虛設。
 *
 *   不靠 AI 自覺寫得清楚、要靠 server 端 lint 卡住、寫得太爛就退回不讓存。
 *
 * 檢查項：
 *   1. title 字數 10~100
 *   2. content 字數 100~3000
 *   3. 必須有至少一個 trigger:xxx tag（不然 AI 不知何時觸發）
 *   4. content 必須有「適用情境段落」關鍵字（何時觸發）
 *   5. content 必須有「規則段落」關鍵字（該做/不該做什麼）
 *   6. 禁止依賴 context 的詞（上次/之前那個/剛剛/這次 session/這次對話）
 *   7. 中英混雜檢查（IR-037 落地）— 計算英文詞比例、扣除白名單後 > 10% 失敗
 *
 * Pure function — 不碰 DB、好測試、好重用。
 *
 * @param {Object} rule - { title, content, tags }
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function lintIronRule(rule) {
  const errors = [];
  const title = (rule?.title || '').trim();
  const content = (rule?.content || '').trim();

  // v1.17.94 reviewer Minor 3：tags 必須是陣列、其他類型給明確訊息
  if (rule?.tags !== undefined && rule?.tags !== null && !Array.isArray(rule.tags)) {
    errors.push(`tags 必須是陣列、收到 ${typeof rule.tags}（值：${JSON.stringify(rule.tags).slice(0, 50)}）`);
  }
  const tags = Array.isArray(rule?.tags) ? rule.tags : [];

  // (1) title 字數（下限 5 字、讓既有 IR-011「時區強制定標準」7字 過、保留 100 字上限）
  if (title.length < 5) {
    errors.push(`title 太短（${title.length} 字）— 標題最少 5 字、寫明適用情境`);
  } else if (title.length > 100) {
    errors.push(`title 太長（${title.length} 字）— 標題上限 100 字、過長會讓鐵律列表難讀`);
  }

  // (2) content 字數（下限降到 50 字、讓既有 IR-020 48字 接近通過；新鐵律建議 100+）
  if (content.length < 50) {
    errors.push(`content 太短（${content.length} 字）— 內容資訊不足、字數最少 50（建議 100+）`);
  } else if (content.length > 3000) {
    errors.push(`content 太長（${content.length} 字）— 內容超過 3000 字、要點不明、請精簡`);
  }

  // (3) trigger:xxx tag
  const triggers = tags.filter(t => typeof t === 'string' && t.startsWith('trigger:'));
  if (triggers.length === 0) {
    errors.push('缺 trigger:xxx tag — 沒觸發詞、AI 不知道何時該想到這條鐵律。tags 至少含一個 trigger:edit / trigger:commit / trigger:deploy 之類');
  }

  // (4) 適用情境段落（v1.17.94 reviewer Important 1：擴充關鍵字）
  // 接受的寫法：「什麼時候適用」「觸發情境」「使用時機」「在什麼場合」「適用場景」「用於」「用在」
  const hasScenarioSection = /適用|觸發|情境|何時|什麼時候|時機|場合|場景|用於|用在/.test(content);
  if (!hasScenarioSection) {
    errors.push('缺適用情境段落 — 內容必須說明「什麼時候適用 / 觸發情境 / 使用時機 / 適用場景」、否則未來 AI 看不懂何時該觸發');
  }

  // (5) 規則段落
  const hasRuleSection = /規則|該做|不該做|禁止|必須|應該|不可|不要/.test(content);
  if (!hasRuleSection) {
    errors.push('缺規則段落 — 內容必須寫明「規則該做什麼 / 不該做什麼 / 禁止 / 必須」、否則看了不知道要幹嘛');
  }

  // (6) 禁止依賴 context 的詞
  const contextPhrases = ['上次', '之前那個', '剛剛', '這次 session', '這次對話', '剛才那個', '剛才那條'];
  const foundContextPhrases = contextPhrases.filter(p => content.includes(p));
  if (foundContextPhrases.length > 0) {
    errors.push(
      `依賴 context 的詞會讓未來 AI 看不懂 — 找到：${foundContextPhrases.join('、')}。請改寫成不依賴當下脈絡的描述（例：用「v1.17.92 的修法」取代「上次的修法」）`
    );
  }

  // (7) 中英混雜檢查（IR-037）
  // 抓連續 4 個以上英文字母的詞、扣除白名單、計算佔比
  const mixedError = checkMixedLanguage(content);
  if (mixedError) {
    errors.push(mixedError);
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

/**
 * 中英混雜檢查
 * 規則：抓連續英文詞、扣白名單（技術詞、程式碼）、佔總字數 > 10% 失敗
 */
function checkMixedLanguage(content) {
  // 白名單：常見技術詞、不算混雜
  // v1.17.94 reviewer Important 2：擴充避免 false-positive 卡住合理鐵律
  const techWhitelist = new Set([
    // 通用通訊協定 / 資料格式
    'API', 'SQL', 'SSH', 'URL', 'HTTP', 'HTTPS', 'JSON', 'TSV', 'CSV', 'XML',
    'YAML', 'CLI', 'UI', 'UX', 'AI', 'LLM', 'MCP', 'CI', 'CD', 'PR',
    // 平台 / 工具
    'OwnMind', 'GitHub', 'GitLab', 'Git', 'Docker', 'Dockerfile', 'Linux', 'Mac', 'Windows',
    'Node', 'npm', 'Postgres', 'PostgreSQL', 'Redis', 'AES', 'Caddy', 'Nginx',
    // SQL 關鍵字
    'WHERE', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'JOIN', 'FROM', 'COPY',
    'COALESCE', 'NULL', 'IS', 'AS', 'ON', 'AND', 'OR', 'NOT',
    // 開發動作 / 流程詞
    'IR', 'commit', 'deploy', 'edit', 'fix', 'bug', 'debug', 'PR',
    'push', 'pull', 'force', 'build', 'cache', 'rebase', 'merge', 'checkout',
    'env', 'file', 'path', 'repo', 'hash', 'port', 'host', 'log', 'test', 'run',
    'code', 'type', 'name', 'key', 'value', 'health', 'endpoint',
    // 業務術語（討論藏資料 / 觀測時常用）
    'filter', 'cutoff', 'audit', 'admin', 'session', 'context',
    // AI 工具名稱
    'Claude', 'Codex', 'Cursor', 'Copilot', 'Gemini', 'ChatGPT', 'Antigravity',
    'OpenCode', 'Windsurf',
    // OwnMind 內部文件 / 概念
    'README', 'CHANGELOG', 'FILELIST', 'SKILL', 'Skill', 'OpenSpec',
    'Spec', 'Memory', 'Project', 'Adapter', 'status', 'Status',
    'Format', 'Reference', 'reference',
  ]);

  // 移除程式碼區塊（``` ... ```）跟 inline code（`...`）跟連結
  let cleaned = content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');  // markdown link 保留 text

  // 抓所有連續 4+ 英文字母的詞
  const words = cleaned.match(/[A-Za-z]{4,}/g) || [];

  // 扣除白名單（case-insensitive）
  const mixedWords = words.filter(w => {
    const lower = w.toLowerCase();
    const upper = w.toUpperCase();
    return !techWhitelist.has(w) && !techWhitelist.has(lower) && !techWhitelist.has(upper);
  });

  if (mixedWords.length === 0) return null;

  // 計算佔比：英文字母總數 / 內容總字數
  const englishCharCount = mixedWords.reduce((sum, w) => sum + w.length, 0);
  const totalCharCount = cleaned.replace(/\s/g, '').length;
  const ratio = totalCharCount > 0 ? englishCharCount / totalCharCount : 0;

  // v1.17.94 reviewer Important 2 折衷：threshold 從 10% 提到 15%
  // 給合理空間吸收 1-2 個 missing 技術詞、但仍能擋下「整段英文」這種明顯違反
  if (ratio > 0.15) {
    return `中英混雜比例 ${(ratio * 100).toFixed(1)}% > 15%（IR-037 違反）— 找到非白名單英文詞 ${mixedWords.length} 個（前 5 個：${mixedWords.slice(0, 5).join(', ')}）。請改成白話中文、技術詞可保留（如 SQL/API/IR-XXX）`;
  }

  return null;
}
