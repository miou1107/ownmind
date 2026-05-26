/**
 * shared/language-lint.js — 語言品質檢查共用 lib（v1.17.95）
 *
 * 為什麼存在：
 *   兩個事件判斷邏輯需要在兩個地方用：
 *     - 中英混雜比例過高（事件常數 LINT_LANGUAGE_MIXED_RATIO）
 *     - 行話沒附白話說明（事件常數 LINT_JARGON_EXPLANATION_REQUIRED）
 *   1. v1.17.94 鐵律品質 lint（寫鐵律時檢查）
 *   2. v1.17.95 回話 lint（AI 回話時檢查 — Stop hook 整合留下個版本）
 *
 *   抽到 shared/、兩邊 import 同一份、避免邏輯漂移。
 *
 *   v1.20.4：違反清單 rule 欄位改用中性事件常數、不再寫死個人鐵律編號（IR-XXX）。
 *   「事件 → 個人鐵律編號」對應由 caller 從規則快取查表處理。
 *
 * 主要 export：
 *   - TECH_WHITELIST: 80 個技術詞白名單（OwnMind 認可、不算中英混雜）
 *   - checkMixedLanguage(content, threshold): 中英混雜檢查
 *   - checkJargonExplanation(content): 行話檢查
 *   - lintReply(content): 兩個一起跑、回 {ok, violations}
 *
 * 設計原則：
 *   - 純函式、不碰 DB、好測試
 *   - 跨平台（Mac/Linux/Windows）— 純 JS、無 native binding
 */

// v1.20.4：lint 事件常數從中性模組 import、不再寫死個人鐵律編號
import {
  LINT_LANGUAGE_MIXED_RATIO,
  LINT_JARGON_EXPLANATION_REQUIRED,
} from './lint-event-types.js';

// 白名單：常見技術詞 / OwnMind 概念詞、不算中英混雜
// 跟 v1.17.94 src/utils/iron-rule-quality.js 同一份
// v1.19.3：基於 30 天 audit Top 30 詞、從 80 詞擴到 200+ 詞、分 8 類
export const TECH_WHITELIST = new Set([
  // ─── 1. 通用通訊協定 / 資料格式（v1.17.94 既有）───
  'API', 'SQL', 'SSH', 'URL', 'HTTP', 'HTTPS', 'JSON', 'JSONL', 'TSV', 'CSV', 'XML',
  'YAML', 'CLI', 'UI', 'UX', 'AI', 'LLM', 'MCP', 'CI', 'CD', 'PR',
  'TCP', 'UDP', 'WebSocket', 'SSE', 'OAuth', 'JWT', 'REST', 'GraphQL', 'gRPC',
  // ─── 2. 平台 / 工具（v1.17.94 既有 + v1.19.3 擴充）───
  'OwnMind', 'GitHub', 'GitLab', 'Git', 'Docker', 'Dockerfile', 'Linux', 'Mac', 'Windows',
  'Node', 'npm', 'Postgres', 'PostgreSQL', 'Redis', 'AES', 'Caddy', 'Nginx',
  'Kubernetes', 'k8s', 'Apache', 'AWS', 'GCP', 'Azure', 'Vercel', 'Netlify',
  // ─── 3. SQL 關鍵字（v1.17.94 既有）───
  'WHERE', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'JOIN', 'FROM', 'COPY',
  'COALESCE', 'NULL', 'IS', 'AS', 'ON', 'AND', 'OR', 'NOT',
  // ─── 4. 開發動作 / 流程詞（v1.17.94 + v1.19.3 audit Top 30 大量擴充）───
  'IR', 'commit', 'commits', 'deploy', 'edit', 'fix', 'bug', 'debug',
  'push', 'pull', 'force', 'build', 'cache', 'rebase', 'merge', 'checkout',
  'env', 'file', 'path', 'repo', 'hash', 'port', 'host', 'log', 'test', 'tests', 'run',
  'code', 'type', 'name', 'key', 'value', 'health', 'endpoint',
  'install', 'uninstall', 'update', 'upgrade', 'script', 'module',
  'import', 'export', 'require',
  // v1.19.3：audit Top 30 — Git / 開發流程
  'main', 'origin', 'branch', 'worktree', 'remote', 'tag', 'stash',
  'review', 'reviewer', 'prod', 'staging', 'spec', 'prompt', 'task', 'tasks',
  'pipeline', 'stage', 'chunk', 'monorepo', 'redirect', 'apply', 'archive',
  'container', 'fresh', 'trigger', 'success', 'failure',
  'plan', 'publish', 'deploy', 'rollback', 'hotfix', 'release',
  // v1.19.3：audit Top 30 — 常見技術概念
  'hook', 'render', 'retry', 'batch', 'topic', 'vertical', 'horizontal',
  'server', 'client', 'handoff', 'project', 'brand', 'token', 'title',
  'async', 'await', 'callback', 'promise', 'middleware', 'dispatcher',
  'payload', 'handler', 'router', 'service', 'factory', 'singleton',
  'instance', 'function', 'class', 'interface', 'schema',
  'array', 'string', 'boolean', 'number', 'error', 'exception', 'timeout',
  'queue', 'lock', 'mutex', 'throttle', 'debounce', 'polling',
  'request', 'response', 'header', 'body', 'query', 'param',
  'pagination', 'sorting', 'auth',
  // ─── 5. 業務術語（v1.17.94 既有 + v1.19.3 擴充）───
  'filter', 'cutoff', 'audit', 'admin', 'session', 'context',
  'fetch', 'sync', 'flush', 'spool', 'pool', 'event', 'events',
  'metric', 'metrics', 'tier', 'role',
  // ─── 6. AI 工具名稱（v1.17.94 既有 + v1.19.3 大公司名）───
  'Claude', 'Codex', 'Cursor', 'Copilot', 'Gemini', 'ChatGPT', 'Antigravity',
  'OpenCode', 'Windsurf',
  // v1.19.3：audit Top 30 — 大公司 / 大平台名
  'Google', 'Meta', 'OpenAI', 'Anthropic', 'Microsoft', 'Apple', 'Amazon',
  'Chrome', 'Firefox', 'Safari', 'Edge', 'YouTube', 'Podcast', 'Imagen',
  'Llama', 'Perplexity', 'Remotion', 'Evernote', 'Sheets', 'Slides', 'Docs',
  'Drive', 'Gmail', 'Calendar', 'Slack', 'Discord', 'Telegram', 'LINE',
  'Notion', 'Figma', 'Looker', 'Tableau',
  // ─── 7. OwnMind 內部文件 / 概念（v1.17.94 既有 + v1.19.3 擴充）───
  'README', 'CHANGELOG', 'FILELIST', 'SKILL', 'Skill', 'OpenSpec',
  'Spec', 'Memory', 'Project', 'Adapter', 'status', 'Status',
  'Format', 'Reference', 'reference',
  'Pipeline', 'Step', 'Phase', 'Stage', 'Notes', 'Research', 'Description',
  // ─── 8. Vin 個人專案名（v1.19.3 新增、audit Top 30）───
  'adog', 'fapa', 'fontrip', 'ring', 'ownmind', 'vincent',
  'auto', 'speech', 'ima', 'asir', 'funit', 'majitreats',
  'kkvin', 'tutorial', 'rescue', 'narrative',
  // ─── 9. v1.19.5 漏字補充（真實踩坑暴露）───
  // shell / terminal / console 系列：v1.19.4 測試 reply 自我介紹漏判踩坑
  'terminal', 'shell', 'console', 'stdout', 'stderr', 'tty',
  // 發版動詞
  'bump',
  // v1.19.4 測試 prompt 暴露的技術詞漏字
  'Suspense', 'Concurrent', 'Pod', 'Saga', 'Envoy', 'Istio',
  'sidecar', 'service mesh', 'kubernetes',
  'monad', 'functor', 'applicative', 'observable',
  'mergeMap', 'switchMap', 'concatMap', 'combineLatest',
  'ajax', 'fromEvent', 'subscribe', 'pipe',
  // 微服務 / 分散式
  'choreography', 'orchestration', 'orchestrator',
  // 函式編程
  'Maybe', 'Either', 'Just', 'Nothing',
  // React / 前端
  'hydration', 'reactive', 'Reactive',
]);

// v1.19.5：建構 lowercase 版本給 case-insensitive 比對
// 為什麼存在：v1.19.3 原本寫 `TECH_WHITELIST.has(w.toLowerCase())` 看似有 normalize、
// 但 Set.has 是精確字串比對。白名單存 'Claude' (PascalCase)、查 'claude' 都 false。
// 真實踩坑：Vin v1.19.4 開新 session 自我介紹「我是 claude」、claude 漏判觸發違規。
export const TECH_WHITELIST_LOWER = new Set(
  Array.from(TECH_WHITELIST).map(w => w.toLowerCase())
);

/**
 * v1.19.3：偵測「大寫開頭孤立詞」當作 proper noun（人名、品牌名）跳過
 * 規則：詞首大寫 + 後接 1 個以上小寫字母（例：Google、Eric、Phoebe）
 * 全大寫詞（AWS、IDE）已在 TECH_WHITELIST、會在前面攔下、不會走到這裡
 */
export function looksLikeProperNoun(word) {
  return /^[A-Z][a-z]+$/.test(word);
}

/**
 * v1.19.3：判斷內容是否含 code block / inline code（用來放寬 threshold）
 */
function hasCodeMarkers(content) {
  return /```[\s\S]*?```|`[^`]+`/.test(content);
}

/**
 * v1.19.3：判斷是否為 code review 場合（含 'code review' 或 'code-review' 字眼、不分大小寫）
 */
function isCodeReviewContext(content) {
  return /\bcode[\s-]review\b/i.test(content);
}

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
 * 抓所有連續 4+ 英文字母詞、扣除白名單 + v1.19.3 扣除 proper noun
 * v1.19.5：白名單比對改用 TECH_WHITELIST_LOWER（修 case-insensitive bug）
 */
function extractNonWhitelistEnglishWords(cleaned) {
  const words = cleaned.match(/[A-Za-z]{4,}/g) || [];
  return words.filter(w => {
    if (TECH_WHITELIST_LOWER.has(w.toLowerCase())) return false;
    // v1.19.3：大寫開頭孤立詞視為 proper noun（人名 / 公司名 / 品牌）、跳過
    if (looksLikeProperNoun(w)) return false;
    return true;
  });
}

/**
 * 中英混雜比例檢查（事件常數 LINT_LANGUAGE_MIXED_RATIO）
 *
 * v1.19.3 變更：
 *   - threshold 分情境：純對話 15%、含 code marker 25%、code review 豁免
 *   - extractNonWhitelistEnglishWords 內自動扣除 proper noun
 *
 * @param {string} content
 * @param {number|object} thresholdOrOptions 數字 = 強制 threshold；物件 = { threshold } 選項
 * @returns {{ok: boolean, ratio: number, mixedWords: string[]}}
 */
export function checkMixedLanguage(content, thresholdOrOptions = undefined) {
  // v1.19.3：code review 場合直接豁免（先於 strip、用原始內容判定）
  if (typeof content === 'string' && isCodeReviewContext(content)) {
    return { ok: true, ratio: 0, mixedWords: [] };
  }

  // v1.19.3：含 code marker → threshold 從 0.15 寬鬆到 0.25
  // caller 沒指定 threshold 才走動態判定；caller 給死值就用死值（向後相容測試）
  let threshold;
  if (typeof thresholdOrOptions === 'number') {
    threshold = thresholdOrOptions;
  } else if (thresholdOrOptions && typeof thresholdOrOptions === 'object' && typeof thresholdOrOptions.threshold === 'number') {
    threshold = thresholdOrOptions.threshold;
  } else if (typeof content === 'string' && hasCodeMarkers(content)) {
    threshold = 0.25;
  } else {
    threshold = 0.15;
  }

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
 * 掃 text、把「後面 80 字內有解釋」的詞加進 seenWords（白話：把已解釋過的詞記下來）
 *
 * v1.20.2 follow-up #3 抽出來、給跨 reply 詞彙記憶共用。
 *
 * @param {string} text - 已清過程式碼跟連結的 text
 * @param {Set<string>} seenWords - 累積的已解釋詞集合（會被 mutate）
 */
function collectExplainedWords(text, seenWords) {
  const wordRegex = /[A-Za-z]{4,}/g;
  let match;
  while ((match = wordRegex.exec(text)) !== null) {
    const word = match[0];
    if (TECH_WHITELIST_LOWER.has(word.toLowerCase())) continue;
    if (looksLikeProperNoun(word)) continue;

    const lowerWord = word.toLowerCase();
    if (seenWords.has(lowerWord)) continue;

    const afterEnd = match.index + word.length;
    const window = text.slice(afterEnd, afterEnd + 80);
    const hasExplanation = /[\(（]/.test(window) ||
                           /[:：]/.test(window) ||
                           /-\s/.test(window) ||
                           /(即|也就是|意思是|簡稱)/.test(window);

    if (hasExplanation) {
      seenWords.add(lowerWord);
    }
  }
}

/**
 * 行話 / 專有名詞必須附白話說明（事件常數 LINT_JARGON_EXPLANATION_REQUIRED）
 *
 * 判斷邏輯：
 *   - 抓非白名單英文詞（連續 4+ 字母）
 *   - 同詞重複只算第一次出現
 *   - 第一次出現位置後 30 字內、要有「（白話說明）」或「：解釋」其中一種
 *   - 沒有 → 違反
 *
 * v1.20.2 follow-up #3：加跨 reply 詞彙記憶。
 *   - historicalCorpus 是「本 session 內前面所有 assistant reply 合併的 text」
 *   - 預先掃 historicalCorpus、把已解釋過的詞加進 seenWords
 *   - 規則內文寫的「上下文已說明過、可保留不改」終於有實作
 *
 * @param {string} content - 當前要檢查的 reply
 * @param {string} [historicalCorpus=''] - 同 session 前面所有 assistant reply 合併（選填）
 * @returns {{ok: boolean, jargonWithoutExplanation: string[]}}
 */
export function checkJargonExplanation(content, historicalCorpus = '') {
  const cleaned = stripCodeAndLinks(content);
  const seenWords = new Set();

  // v1.20.2 follow-up #3: 預先掃歷史 corpus、把已解釋過的詞加進 seenWords
  if (historicalCorpus && typeof historicalCorpus === 'string') {
    const historicalCleaned = stripCodeAndLinks(historicalCorpus);
    collectExplainedWords(historicalCleaned, seenWords);
  }

  const jargonWithoutExplanation = [];

  // 用 regex match 連續英文詞 + 位置
  const wordRegex = /[A-Za-z]{4,}/g;
  let match;
  while ((match = wordRegex.exec(cleaned)) !== null) {
    const word = match[0];
    const pos = match.index;

    // 白名單跳過（v1.19.5：用 LOWER set 修 case-insensitive bug）
    if (TECH_WHITELIST_LOWER.has(word.toLowerCase())) {
      continue;
    }

    // v1.19.3: proper noun（人名 / 公司名）跳過
    if (looksLikeProperNoun(word)) continue;

    // 同詞只算第一次出現
    const lowerWord = word.toLowerCase();
    if (seenWords.has(lowerWord)) continue;
    seenWords.add(lowerWord);

    // v1.19.3：視窗從 50 字擴到 80 字（Codex 對抗審查指出中文語境 50 字太短、
    // 解釋常在括號外被切掉）
    const afterEnd = pos + word.length;
    const window = cleaned.slice(afterEnd, afterEnd + 80);

    // 認可的解釋形式：
    // 1. 括號內白話：(...) 或 （...）
    // 2. 冒號後解釋：:... 或 ：...
    // 3. 「即」「也就是」開頭
    // 4. 連字號「-」開頭的同位解釋（例：refactor - 重構但不改行為）
    // v1.19.3：解釋不需貼著詞、可在 80 字內任意位置（中文語境補充常隔句出現）
    const hasExplanation = /[\(（]/.test(window) ||
                           /[:：]/.test(window) ||
                           /-\s/.test(window) ||
                           /(即|也就是|意思是|簡稱)/.test(window);

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
 *
 * v1.20.2 follow-up #3：加跨 reply 詞彙記憶。
 *   - historicalCorpus 是「本 session 內前面所有 assistant reply 合併的 text」
 *   - 傳進來才會啟用「已解釋過的詞跳過行話檢查」
 *
 * @param {string} content - 當前要檢查的 reply
 * @param {string} [historicalCorpus=''] - 同 session 前面所有 assistant reply 合併（選填）
 * @returns {{ok: boolean, violations: Array<{rule: string, message: string}>}}
 */
export function lintReply(content, historicalCorpus = '') {
  const violations = [];

  const mixed = checkMixedLanguage(content);
  if (!mixed.ok) {
    violations.push({
      rule: LINT_LANGUAGE_MIXED_RATIO,
      message: `中英混雜比例 ${(mixed.ratio * 100).toFixed(1)}% > 15% — 找到 ${mixed.mixedWords.length} 個非白名單英文詞（前 5：${mixed.mixedWords.slice(0, 5).join(', ')}）。請改成白話中文`,
      detail: { ratio: mixed.ratio, mixedWords: mixed.mixedWords },
    });
  }

  const jargon = checkJargonExplanation(content, historicalCorpus);
  if (!jargon.ok) {
    violations.push({
      rule: LINT_JARGON_EXPLANATION_REQUIRED,
      message: `行話 / 專有名詞沒附白話說明 — ${jargon.jargonWithoutExplanation.length} 個詞（${jargon.jargonWithoutExplanation.slice(0, 5).join(', ')}）後面 50 字內沒有「（白話）」「：解釋」「即...」之類補充`,
      detail: { jargon: jargon.jargonWithoutExplanation },
    });
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}
