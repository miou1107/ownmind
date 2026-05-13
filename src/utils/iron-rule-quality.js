import { detectFrontmatter } from './iron-rule-frontmatter.js';

/**
 * lintIronRule — 鐵律品質檢查（程式邏輯卡控、IR-027 落地）
 *
 * v1.18.0 升級：偵測 SKILL.md frontmatter
 *   - 有 frontmatter → 走 schema lint S1-S9（spec.md §1.3）
 *   - 沒 frontmatter → 走 v1.17.94 regex lint（向後相容、既有 35 條鐵律不爆）
 *
 * v1.17.94 規則（沒 frontmatter 走這條）：
 *   1. title 字數 5~100
 *   2. content 字數 50~3000
 *   3. 必須有至少一個 trigger:xxx tag
 *   4. content 必須有「適用情境段落」關鍵字
 *   5. content 必須有「規則段落」關鍵字
 *   6. 禁止依賴 context 的詞
 *   7. 中英混雜檢查（IR-037）
 *
 * Pure function — 不碰 DB、好測試、好重用。
 *
 * @param {Object} rule - { title, content, tags }
 * @returns {{
 *   ok: boolean,
 *   errors: string[],
 *   warnings?: string[],
 *   format?: 'skill_md' | 'legacy_text'
 * }}
 *   - ok: errors 為空才 true（warnings 不算）
 *   - format: 給 server response 用、客戶端可顯示「這條走哪個 lint path」
 */
export function lintIronRule(rule) {
  const content = (rule?.content || '').trim();

  // v1.18.0: 先偵測 frontmatter — 有就走 schema lint
  const fm = detectFrontmatter(content);
  if (fm.has) {
    // v1.18.0 review B1 修正：YAML parse 失敗 → fallback 到 legacy regex lint
    //   理由：user 可能寫 `---` 當分隔線（不是真的要寫 SKILL.md）、parseError
    //   直接 reject 會困惑。fallback + warning 通知 user「偵測到但解析失敗」。
    if (fm.parseError) {
      const legacyResult = lintLegacyTextRule(rule);
      const warnings = [...(legacyResult.warnings || [])];
      warnings.push(
        `偵測到 frontmatter marker（---）但 YAML 解析失敗（${fm.parseError}）— ` +
        `退回 free-text lint。若刻意寫 SKILL.md 格式、請修 YAML 語法；若 --- 是內文分隔線、忽略此警告即可。`
      );
      return { ...legacyResult, warnings };
    }
    return lintSkillMdRule(rule, fm);
  }

  return lintLegacyTextRule(rule);
}

/**
 * v1.18.0 — SKILL.md frontmatter schema lint（規則 S1-S9）
 * 對齊 spec.md §1.3
 *
 * @param {Object} rule
 * @param {{ has: boolean, frontmatter?: object, body?: string, parseError?: string }} fm
 *   detectFrontmatter() 結果
 */
export function lintSkillMdRule(rule, fm) {
  const errors = [];
  const warnings = [];
  const tags = Array.isArray(rule?.tags) ? rule.tags : [];

  // S1 — YAML 解析合法
  if (fm.parseError) {
    errors.push(`S1 frontmatter YAML 解析失敗：${fm.parseError}`);
    return { ok: false, errors, warnings, format: 'skill_md' };
  }

  const frontmatter = fm.frontmatter;
  const body = (fm.body || '').trim();

  // S2 — name 必填、kebab-case ASCII only
  //
  // v1.18.0-rc3 review I4 修正：之前曾擴充接受中文 BMP、但跨平台 fs 危險
  //   (macOS NFC/NFD normalize 不一致、Linux git path 跨平台壞)
  //   → 收緊回 ASCII only。suggest helper 改用「title hash + ASCII hint」推 name
  //
  // 對齊 Anthropic SKILL.md 官方範例 (pdf, xlsx, skill-creator) 全 ASCII
  const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  if (!name) {
    errors.push('S2 frontmatter 缺 name 欄位（必填）');
  } else if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name)) {
    errors.push(`S2 name "${name}" 不是 kebab-case（必須 ^[a-z0-9-]+$、頭尾不可 -、ASCII only）`);
  }

  // S3 — name 字數 3-60
  if (name) {
    if (name.length < 3) errors.push(`S3 name 太短（${name.length} 字、最少 3）`);
    else if (name.length > 60) errors.push(`S3 name 太長（${name.length} 字、上限 60）`);
  }

  // S4 — description 必填、20-500 字
  const description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
  if (!description) {
    errors.push('S4 frontmatter 缺 description 欄位（必填、必須寫「何時觸發」）');
  } else {
    if (description.length < 20) errors.push(`S4 description 太短（${description.length} 字、最少 20）— 寫不清楚 AI 不會觸發這條鐵律`);
    else if (description.length > 500) errors.push(`S4 description 太長（${description.length} 字、上限 500）— 摘要不該超過 500 字、細節寫進 body`);
  }

  // S5 — description 含觸發詞
  if (description && description.length >= 20) {
    if (!/when|whenever|use\s+when|triggers\s+on|何時|觸發|情境|準備|要做/i.test(description)) {
      errors.push('S5 description 沒寫「何時觸發」— 必須含「when / 何時 / 觸發 / 情境 / 準備」之類觸發詞、AI 才知道何時 invoke 這條鐵律');
    }
  }

  // S6 — body 字數 ≥ 100
  if (body.length < 100) {
    errors.push(`S6 body 太短（${body.length} 字、最少 100）— body 是給 AI 看細節、太短失去鐵律的 do/dont 教訓價值`);
  }

  // S7 — body 含規則段落關鍵字（沿用 v1.17.94 #5）
  if (body.length >= 100 && !/規則|該做|不該做|禁止|必須|應該|不可|不要/.test(body)) {
    errors.push('S7 body 缺規則段落 — 必須寫明「規則該做什麼 / 不該做什麼 / 禁止 / 必須」、否則 AI 看不懂該做啥');
  }

  // S8 — 中英混雜檢查（沿用 v1.17.94 #7、檢 body + description 合併）
  // 注意：description 是 SKILL.md 標準英文寫法（pushy「Use when ... Triggers on ...」）、
  // 不該被當混雜算進 ratio。只檢 body 段。
  const mixedError = checkMixedLanguage(body);
  if (mixedError) {
    errors.push(`S8 ${mixedError}`);
  }

  // S9 — description 字數 < 50 → warning（不 reject）
  if (description && description.length >= 20 && description.length < 50) {
    warnings.push(`S9 description ${description.length} 字偏短（建議 50+ 寫得更 pushy、AI 觸發率更高）`);
  }

  // tags 結構檢查（保留 v1.17.94 reviewer Minor 3 行為）
  if (rule?.tags !== undefined && rule?.tags !== null && !Array.isArray(rule.tags)) {
    errors.push(`tags 必須是陣列、收到 ${typeof rule.tags}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    format: 'skill_md',
  };
}

/**
 * v1.17.94 — legacy free-text lint（沒 frontmatter 走這條）
 */
export function lintLegacyTextRule(rule) {
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
    warnings: [],
    format: 'legacy_text',
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
