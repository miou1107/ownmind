/**
 * shared/language-lint.js — 語言品質檢查共用 lib（v1.17.95）
 *
 * 為什麼存在：
 *   IR-037（中英混雜）+ IR-036（行話沒附白話說明）的判斷邏輯需要在兩個地方用：
 *   1. v1.17.94 鐵律品質 lint（寫鐵律時檢查）
 *   2. v1.17.95 回話 lint（AI 回話時檢查 — Stop hook 整合留下個版本）
 *
 *   抽到 shared/、兩邊 import 同一份、避免邏輯漂移。
 *
 * 主要 export：
 *   - TECH_WHITELIST: 80 個技術詞白名單（OwnMind 認可、不算中英混雜）
 *   - checkMixedLanguage(content, threshold): IR-037 檢查
 *   - checkJargonExplanation(content): IR-036 檢查
 *   - lintReply(content): 兩個一起跑、回 {ok, violations}
 *
 * 設計原則：
 *   - 純函式、不碰 DB、好測試
 *   - 跨平台（Mac/Linux/Windows）— 純 JS、無 native binding
 */

// 白名單：常見技術詞 / OwnMind 概念詞、不算中英混雜
// 跟 v1.17.94 src/utils/iron-rule-quality.js 同一份
export const TECH_WHITELIST = new Set([
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
  'IR', 'commit', 'deploy', 'edit', 'fix', 'bug', 'debug',
  'push', 'pull', 'force', 'build', 'cache', 'rebase', 'merge', 'checkout',
  'env', 'file', 'path', 'repo', 'hash', 'port', 'host', 'log', 'test', 'run',
  'code', 'type', 'name', 'key', 'value', 'health', 'endpoint',
  'install', 'uninstall', 'update', 'upgrade', 'script', 'module',
  'import', 'export', 'require',
  // 業務術語
  'filter', 'cutoff', 'audit', 'admin', 'session', 'context',
  // AI 工具名稱
  'Claude', 'Codex', 'Cursor', 'Copilot', 'Gemini', 'ChatGPT', 'Antigravity',
  'OpenCode', 'Windsurf',
  // OwnMind 內部文件 / 概念
  'README', 'CHANGELOG', 'FILELIST', 'SKILL', 'Skill', 'OpenSpec',
  'Spec', 'Memory', 'Project', 'Adapter', 'status', 'Status',
  'Format', 'Reference', 'reference',
]);

/**
 * 把內容裡的程式碼區塊、URL、markdown link 拿掉、避免誤判
 */
function stripCodeAndLinks(content) {
  return content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

/**
 * 抓所有連續 4+ 英文字母詞、扣除白名單
 */
function extractNonWhitelistEnglishWords(cleaned) {
  const words = cleaned.match(/[A-Za-z]{4,}/g) || [];
  return words.filter(w => {
    const lower = w.toLowerCase();
    const upper = w.toUpperCase();
    return !TECH_WHITELIST.has(w) && !TECH_WHITELIST.has(lower) && !TECH_WHITELIST.has(upper);
  });
}

/**
 * IR-037: 中英混雜比例檢查
 * @param {string} content
 * @param {number} threshold 預設 0.15
 * @returns {{ok: boolean, ratio: number, mixedWords: string[]} | null}
 */
export function checkMixedLanguage(content, threshold = 0.15) {
  const cleaned = stripCodeAndLinks(content);
  const mixedWords = extractNonWhitelistEnglishWords(cleaned);
  if (mixedWords.length === 0) return { ok: true, ratio: 0, mixedWords: [] };

  const englishCharCount = mixedWords.reduce((sum, w) => sum + w.length, 0);
  const totalCharCount = cleaned.replace(/\s/g, '').length;
  const ratio = totalCharCount > 0 ? englishCharCount / totalCharCount : 0;

  return {
    ok: ratio <= threshold,
    ratio,
    mixedWords,
  };
}

/**
 * IR-036: 行話 / 專有名詞必須附白話說明
 *
 * 判斷邏輯：
 *   - 抓非白名單英文詞（連續 4+ 字母）
 *   - 同詞重複只算第一次出現
 *   - 第一次出現位置後 30 字內、要有「（白話說明）」或「：解釋」其中一種
 *   - 沒有 → 違反
 *
 * @param {string} content
 * @returns {{ok: boolean, jargonWithoutExplanation: string[]}}
 */
export function checkJargonExplanation(content) {
  const cleaned = stripCodeAndLinks(content);
  const seenWords = new Set();
  const jargonWithoutExplanation = [];

  // 用 regex match 連續英文詞 + 位置
  const wordRegex = /[A-Za-z]{4,}/g;
  let match;
  while ((match = wordRegex.exec(cleaned)) !== null) {
    const word = match[0];
    const pos = match.index;

    // 白名單跳過
    if (TECH_WHITELIST.has(word) ||
        TECH_WHITELIST.has(word.toLowerCase()) ||
        TECH_WHITELIST.has(word.toUpperCase())) {
      continue;
    }

    // 同詞只算第一次出現
    const lowerWord = word.toLowerCase();
    if (seenWords.has(lowerWord)) continue;
    seenWords.add(lowerWord);

    // 看詞後 50 字內有沒有解釋（增寬窗口避免誤判緊接的解釋被切掉）
    const afterEnd = pos + word.length;
    const window = cleaned.slice(afterEnd, afterEnd + 50);

    // 認可的解釋形式：
    // 1. 括號內白話：(...) 或 （...）
    // 2. 冒號後解釋：:... 或 ：...
    // 3. 「即」「也就是」開頭
    // 4. 連字號「-」開頭的同位解釋（例：refactor - 重構但不改行為）
    const hasExplanation = /^[\s]*[\(（]/.test(window) ||
                           /^[\s]*[:：]/.test(window) ||
                           /^[\s]*-\s/.test(window) ||
                           /^[\s]*(即|也就是|意思是|簡稱)/.test(window);

    if (!hasExplanation) {
      jargonWithoutExplanation.push(word);
    }
  }

  return {
    ok: jargonWithoutExplanation.length === 0,
    jargonWithoutExplanation,
  };
}

/**
 * 跑兩個檢查、回統一格式
 * @param {string} content
 * @returns {{ok: boolean, violations: Array<{rule: string, message: string}>}}
 */
export function lintReply(content) {
  const violations = [];

  const mixed = checkMixedLanguage(content);
  if (!mixed.ok) {
    violations.push({
      rule: 'IR-037',
      message: `中英混雜比例 ${(mixed.ratio * 100).toFixed(1)}% > 15% — 找到 ${mixed.mixedWords.length} 個非白名單英文詞（前 5：${mixed.mixedWords.slice(0, 5).join(', ')}）。請改成白話中文`,
      detail: { ratio: mixed.ratio, mixedWords: mixed.mixedWords },
    });
  }

  const jargon = checkJargonExplanation(content);
  if (!jargon.ok) {
    violations.push({
      rule: 'IR-036',
      message: `行話 / 專有名詞沒附白話說明 — ${jargon.jargonWithoutExplanation.length} 個詞（${jargon.jargonWithoutExplanation.slice(0, 5).join(', ')}）後面 50 字內沒有「（白話）」「：解釋」「即...」之類補充`,
      detail: { jargon: jargon.jargonWithoutExplanation },
    });
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}
