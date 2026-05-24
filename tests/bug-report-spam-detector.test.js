import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateLevenshteinSimilarity,
  detectSimilarPairs,
  detectSpam,
  SPAM_THRESHOLDS,
} from '../src/services/bug-report-spam-detector.js';

// ============================================================
// 門檻值（spec.md v4.1 對齊）
// ============================================================

test('門檻：24h 30 筆、1h 同指紋 5 筆、1h 5 筆+3 相似', () => {
  assert.equal(SPAM_THRESHOLDS.HIGH_VOLUME_24H_COUNT, 30);
  assert.equal(SPAM_THRESHOLDS.REPEATED_FINGERPRINT_1H_COUNT, 5);
  assert.equal(SPAM_THRESHOLDS.HIGH_VOLUME_1H_COUNT, 5);
  assert.equal(SPAM_THRESHOLDS.SIMILAR_CONTENT_PAIR_COUNT, 3);
  assert.equal(SPAM_THRESHOLDS.SIMILARITY_RATIO, 0.8);
});

// ============================================================
// Levenshtein 相似度
// ============================================================

test('Levenshtein 相似度：完全一樣回 1.0', () => {
  assert.equal(calculateLevenshteinSimilarity('hello', 'hello'), 1);
});

test('Levenshtein 相似度：完全不同回低分', () => {
  const s = calculateLevenshteinSimilarity('abc', 'xyz');
  assert.ok(s < 0.5, `預期 < 0.5、實際 ${s}`);
});

test('Levenshtein 相似度：相近字串回高分', () => {
  // 改一個字、長度 10 → 相似度 ≈ 0.9
  const s = calculateLevenshteinSimilarity('hello world', 'hello world!');
  assert.ok(s >= 0.9, `預期 ≥ 0.9、實際 ${s}`);
});

test('Levenshtein 相似度：兩個空字串回 1.0', () => {
  assert.equal(calculateLevenshteinSimilarity('', ''), 1);
});

test('Levenshtein 相似度：一空一非空回 0', () => {
  assert.equal(calculateLevenshteinSimilarity('', 'abc'), 0);
});

test('Levenshtein 相似度：非字串型別回 0', () => {
  assert.equal(calculateLevenshteinSimilarity(null, 'x'), 0);
  assert.equal(calculateLevenshteinSimilarity(123, 'x'), 0);
});

// ============================================================
// detectSimilarPairs：在多筆報告中找相似度 > 閾值的對
// ============================================================

test('detectSimilarPairs：5 筆裡 3 筆高度相似 → 回那 3 筆 id', () => {
  const reports = [
    { id: 1, title: '寫入被擋', description: '我寫專案記憶被擋' },
    { id: 2, title: '寫入被擋', description: '我寫專案記憶被擋' },
    { id: 3, title: '完全不同的問題', description: 'xyz' },
    { id: 4, title: '寫入被擋', description: '我寫專案記憶被擋' },
    { id: 5, title: '另一個問題', description: 'abc' },
  ];
  const result = detectSimilarPairs(reports, 0.8);
  assert.ok(result.has_cluster);
  assert.ok(result.cluster_ids.length >= 3);
  for (const id of [1, 2, 4]) {
    assert.ok(result.cluster_ids.includes(id), `id=${id} 應在 cluster`);
  }
});

test('detectSimilarPairs：都不相似 → has_cluster=false', () => {
  const reports = [
    { id: 1, title: 'A', description: 'aaa' },
    { id: 2, title: 'B', description: 'bbb' },
    { id: 3, title: 'C', description: 'ccc' },
  ];
  const result = detectSimilarPairs(reports, 0.8);
  assert.equal(result.has_cluster, false);
});

// ============================================================
// detectSpam：綜合三條規則、回觸發結果
// ============================================================

test('detectSpam 規則 1：1h 5 筆 + 3 相似 → high_volume_1h + similar_content', async () => {
  // mock DB 回 1h 5 筆、其中 3 筆內容一樣
  const reports = [
    { id: 11, title: '寫入被擋', description: '同樣的描述' },
    { id: 12, title: '寫入被擋', description: '同樣的描述' },
    { id: 13, title: '寫入被擋', description: '同樣的描述' },
    { id: 14, title: '另一個', description: 'aaa' },
    { id: 15, title: '又一個', description: 'bbb' },
  ];
  const mockQuery = async (sql) => {
    if (sql.includes("'1 hour'") || sql.includes("1 HOUR")) {
      return { rows: reports };
    }
    return { rows: [] };
  };
  const r = await detectSpam(mockQuery, 1);
  assert.ok(r.triggered);
  assert.equal(r.trigger_rule, 'similar_content');
  assert.ok(r.report_ids.length >= 3);
});

test('detectSpam 規則 2：24h 30 筆 → high_volume_24h', async () => {
  const reports30 = Array.from({ length: 30 }, (_, i) => ({
    id: 100 + i,
    title: `bug ${i}`,
    description: `不同的內容 ${i}`,
  }));
  const mockQuery = async (sql) => {
    if (sql.includes("'24 hours'") || sql.includes('24 HOURS')) {
      return { rows: reports30 };
    }
    if (sql.includes("'1 hour'") || sql.includes('1 HOUR')) {
      // 1h 內只有 2 筆、不觸發規則 1
      return { rows: reports30.slice(-2) };
    }
    return { rows: [] };
  };
  const r = await detectSpam(mockQuery, 1);
  assert.ok(r.triggered);
  assert.equal(r.trigger_rule, 'high_volume_24h');
  assert.equal(r.report_ids.length, 30);
});

test('detectSpam 規則 3：1h 同指紋 5 筆 → repeated_fingerprint', async () => {
  // 注意：實際上介面層會擋 3 筆、所以此情境少見、但偵測器仍要能抓
  const sameFpReports = Array.from({ length: 5 }, (_, i) => ({
    id: 200 + i,
    title: `same fp ${i}`,
    description: `各自不同 ${i}`,
    bug_fingerprint: 'mem_blocked_secret_keyword',
  }));
  const mockQuery = async (sql) => {
    if (sql.includes("'1 hour'") && sql.includes('bug_fingerprint')) {
      return { rows: sameFpReports };
    }
    if (sql.includes("'1 hour'")) {
      return { rows: sameFpReports };
    }
    return { rows: [] };
  };
  const r = await detectSpam(mockQuery, 1);
  assert.ok(r.triggered);
  assert.equal(r.trigger_rule, 'repeated_fingerprint');
  assert.equal(r.report_ids.length, 5);
});

test('detectSpam：都不觸發 → triggered=false', async () => {
  const mockQuery = async () => ({ rows: [] });
  const r = await detectSpam(mockQuery, 1);
  assert.equal(r.triggered, false);
});

test('detectSpam：1h 4 筆（沒到 5）→ 不觸發', async () => {
  const reports4 = Array.from({ length: 4 }, (_, i) => ({
    id: i,
    title: `t${i}`,
    description: `d${i}`,
  }));
  const mockQuery = async (sql) => {
    if (sql.includes("'1 hour'")) return { rows: reports4 };
    return { rows: [] };
  };
  const r = await detectSpam(mockQuery, 1);
  assert.equal(r.triggered, false);
});
