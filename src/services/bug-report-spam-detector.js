/**
 * bug-report-spam-detector — automatically flags suspected spam (in plain terms:
 * automatically catch people who may be submitting junk reports, for an admin to
 * review and decide whether to block)
 *
 * Implements OpenSpec proposal v1.19.14-bug-report-tool (spec §3: spam detector,
 * scenarios 23-27).
 *
 * Three rules (v4.1 thresholds):
 *
 *   Rule 1: similar_content
 *     ≥ 5 reports within 1 hour + ≥ 3 of them have (title + description) similarity > 80%
 *
 *   Rule 2: high_volume_24h
 *     ≥ 30 reports within 24 hours
 *
 *   Rule 3: repeated_fingerprint
 *     ≥ 5 reports with the same bug_fingerprint within 1 hour
 *     (note: the interface layer 429s on the 3rd, so 5 is rarely reached in practice,
 *      but the detector still catches it)
 *
 * Design notes:
 *   - pure function + DB query (query is injected by the caller, easy to test)
 *   - the compute-heavy task (similarity) runs in the background, not blocking the create API
 *   - the detection itself is rate-limited (triggered once per write, costs at most 50ms)
 */

export const SPAM_THRESHOLDS = {
  HIGH_VOLUME_24H_COUNT: 30,
  HIGH_VOLUME_1H_COUNT: 5,
  REPEATED_FINGERPRINT_1H_COUNT: 5,
  SIMILAR_CONTENT_PAIR_COUNT: 3, // at least 3 of the 5 are similar
  SIMILARITY_RATIO: 0.8,
};

/**
 * Levenshtein distance: the minimum number of character edits to make two strings equal.
 * Solved with standard dynamic programming (O(L_a * L_b)).
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} edit distance
 */
function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // dp[i][j] = the minimum steps to turn a[0..i] into b[0..j]
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
 * Levenshtein similarity = 1 - (distance / max(length))
 * Range 0-1, where 1 means identical
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
 * Find similar clusters within a set of reports:
 * if ≥ pairThreshold reports have pairwise similarity ≥ similarityThreshold, return their ids
 *
 * Simplified approach: compute similarity for each pair, use union-find to merge highly
 * similar ones into clusters, then check whether the largest cluster reaches pairThreshold.
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

  // concatenate title + description as the comparison string
  const texts = reports.map((r) => `${r.title || ''} ${r.description || ''}`);

  // union-find structure
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

  // tally each cluster's size
  const groupSize = new Map();
  for (let i = 0; i < reports.length; i++) {
    const root = find(i);
    groupSize.set(root, (groupSize.get(root) || 0) + 1);
  }

  // find the largest cluster; trigger if it reaches pairThreshold
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
 * Detect whether a user triggers a spam rule
 *
 * @param {Function} query - DB query (text, params) => Promise<{ rows }>
 * @param {number} userId
 * @returns {Promise<{ triggered: false } | { triggered: true, trigger_rule: string, report_ids: number[] }>}
 */
export async function detectSpam(query, userId) {
  // ── Check Rule 2 first (cheapest, count only) ─────────────────────
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

  // ── Rule 3: same fingerprint within 1h ─────────────────────────
  // count per fingerprint
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

  // ── Rule 1: ≥ 5 reports within 1h + ≥ 3 similar ────────────────────
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
 * Write the detection result into the bug_report_spam_suspects table (pending admin review)
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
