/**
 * bug-report-spam-detector — 自動標出疑似 spam（白話：自動抓出可能在亂送
 * 回報的人、由管理員審查確認是否封鎖）
 *
 * 對應 OpenSpec 提案 v1.19.14-bug-report-tool（規格 §三：spam 偵測器、
 * 場景 23-27）。
 *
 * 三條規則（v4.1 門檻）：
 *
 *   規則 1：similar_content
 *     1 小時內送 ≥ 5 筆 + 其中 ≥ 3 筆 (title + description) 相似度 > 80%
 *
 *   規則 2：high_volume_24h
 *     24 小時內送 ≥ 30 筆
 *
 *   規則 3：repeated_fingerprint
 *     1 小時內同 bug_fingerprint ≥ 5 筆
 *     （注意：介面層會在第 3 筆 429、實際很少能到 5、但偵測器仍抓）
 *
 * 設計重點：
 *   - 純函式 + DB 查詢（query 由 caller 注入、好測試）
 *   - 計算密集任務（相似度）背景跑、不卡建立 API
 *   - 偵測本身有頻率限制（每筆寫入觸發一次、最多耗 50ms）
 */

export const SPAM_THRESHOLDS = {
  HIGH_VOLUME_24H_COUNT: 30,
  HIGH_VOLUME_1H_COUNT: 5,
  REPEATED_FINGERPRINT_1H_COUNT: 5,
  SIMILAR_CONTENT_PAIR_COUNT: 3, // 5 筆中至少 3 筆相似
  SIMILARITY_RATIO: 0.8,
};

/**
 * Levenshtein 距離：兩個字串「最少要改幾個字才能變相同」
 * 用標準 dynamic programming 解（O(L_a * L_b)）
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} 編輯距離
 */
function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // dp[i][j] = a[0..i] 改成 b[0..j] 的最少步數
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1];
      } else {
        cur[j] = 1 + Math.min(prev[j], cur[j - 1], prev[j - 1]);
      }
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Levenshtein 相似度 = 1 - (距離 / max(長度))
 * 範圍 0-1、1 表完全一樣
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function calculateLevenshteinSimilarity(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return 0;
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const dist = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  return 1 - dist / maxLen;
}

/**
 * 在一組報告中找相似的群（cluster）：
 * 若有 ≥ pairThreshold 筆之間兩兩相似度 ≥ similarityThreshold、回那些 id
 *
 * 簡化做法：對每筆配對計算相似度、用 union-find 把高度相似的併群、
 * 找最大群是否達 pairThreshold。
 *
 * @param {Array<{ id: number, title: string, description: string }>} reports
 * @param {number} similarityThreshold
 * @param {number} [pairThreshold=3]
 * @returns {{ has_cluster: boolean, cluster_ids: number[] }}
 */
export function detectSimilarPairs(reports, similarityThreshold, pairThreshold = 3) {
  if (!Array.isArray(reports) || reports.length < pairThreshold) {
    return { has_cluster: false, cluster_ids: [] };
  }

  // 串接 title + description 當比對字串
  const texts = reports.map((r) => `${r.title || ''} ${r.description || ''}`);

  // union-find 結構
  const parent = reports.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i, j) => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  };

  for (let i = 0; i < reports.length; i++) {
    for (let j = i + 1; j < reports.length; j++) {
      const sim = calculateLevenshteinSimilarity(texts[i], texts[j]);
      if (sim >= similarityThreshold) {
        union(i, j);
      }
    }
  }

  // 統計各群大小
  const groupSize = new Map();
  for (let i = 0; i < reports.length; i++) {
    const root = find(i);
    groupSize.set(root, (groupSize.get(root) || 0) + 1);
  }

  // 找最大群、若達 pairThreshold 即觸發
  let bestRoot = null;
  let bestSize = 0;
  for (const [root, size] of groupSize) {
    if (size > bestSize) {
      bestSize = size;
      bestRoot = root;
    }
  }

  if (bestSize < pairThreshold) {
    return { has_cluster: false, cluster_ids: [] };
  }

  const clusterIds = reports
    .filter((_, i) => find(i) === bestRoot)
    .map((r) => r.id);

  return { has_cluster: true, cluster_ids: clusterIds };
}

/**
 * 偵測使用者是否觸發 spam 規則
 *
 * @param {Function} query - DB query (text, params) => Promise<{ rows }>
 * @param {number} userId
 * @returns {Promise<{ triggered: false } | { triggered: true, trigger_rule: string, report_ids: number[] }>}
 */
export async function detectSpam(query, userId) {
  // ── 規則 2 先檢（最便宜、只計數）─────────────────────
  const reports24h = (await query(
    `SELECT id, title, description, bug_fingerprint
       FROM bug_reports
      WHERE user_id = $1
        AND created_at > now() - INTERVAL '24 hours'
      ORDER BY created_at DESC`,
    [userId]
  )).rows;

  if (reports24h.length >= SPAM_THRESHOLDS.HIGH_VOLUME_24H_COUNT) {
    return {
      triggered: true,
      trigger_rule: 'high_volume_24h',
      report_ids: reports24h.map((r) => r.id),
    };
  }

  // ── 規則 3：1h 同 fingerprint ─────────────────────────
  // 對每個 fingerprint 計數
  const reports1h = (await query(
    `SELECT id, title, description, bug_fingerprint
       FROM bug_reports
      WHERE user_id = $1
        AND created_at > now() - INTERVAL '1 hour'
      ORDER BY created_at DESC`,
    [userId]
  )).rows;

  const fpCount = {};
  for (const r of reports1h) {
    if (!r.bug_fingerprint) continue;
    fpCount[r.bug_fingerprint] = (fpCount[r.bug_fingerprint] || 0) + 1;
  }
  for (const [fp, count] of Object.entries(fpCount)) {
    if (count >= SPAM_THRESHOLDS.REPEATED_FINGERPRINT_1H_COUNT) {
      return {
        triggered: true,
        trigger_rule: 'repeated_fingerprint',
        report_ids: reports1h
          .filter((r) => r.bug_fingerprint === fp)
          .map((r) => r.id),
      };
    }
  }

  // ── 規則 1：1h ≥ 5 筆 + ≥ 3 筆相似 ────────────────────
  if (reports1h.length >= SPAM_THRESHOLDS.HIGH_VOLUME_1H_COUNT) {
    const cluster = detectSimilarPairs(
      reports1h,
      SPAM_THRESHOLDS.SIMILARITY_RATIO,
      SPAM_THRESHOLDS.SIMILAR_CONTENT_PAIR_COUNT
    );
    if (cluster.has_cluster) {
      return {
        triggered: true,
        trigger_rule: 'similar_content',
        report_ids: cluster.cluster_ids,
      };
    }
  }

  return { triggered: false };
}

/**
 * 把偵測結果寫進 bug_report_spam_suspects 表（待管理員審查）
 *
 * @param {Function} query
 * @param {number} userId
 * @param {string} triggerRule
 * @param {number[]} reportIds
 * @returns {Promise<{ id: number } | null>}
 */
export async function recordSpamSuspect(query, userId, triggerRule, reportIds) {
  const result = await query(
    `INSERT INTO bug_report_spam_suspects (user_id, trigger_rule, report_ids)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [userId, triggerRule, reportIds]
  );
  return result.rows[0] || null;
}
