import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateLevenshteinSimilarity,
  detectSimilarPairs,
  detectSpam,
  SPAM_THRESHOLDS,
} from '../src/services/bug-report-spam-detector.js';

// ============================================================
// Thresholds (aligned with spec.md v4.1)
// ============================================================

test('thresholds: 24h 30 reports, 1h same fingerprint 5 reports, 1h 5 reports + 3 similar', () => {
  assert.equal(SPAM_THRESHOLDS.HIGH_VOLUME_24H_COUNT, 30);
  assert.equal(SPAM_THRESHOLDS.REPEATED_FINGERPRINT_1H_COUNT, 5);
  assert.equal(SPAM_THRESHOLDS.HIGH_VOLUME_1H_COUNT, 5);
  assert.equal(SPAM_THRESHOLDS.SIMILAR_CONTENT_PAIR_COUNT, 3);
  assert.equal(SPAM_THRESHOLDS.SIMILARITY_RATIO, 0.8);
});

// ============================================================
// Levenshtein similarity
// ============================================================

test('Levenshtein similarity: identical returns 1.0', () => {
  assert.equal(calculateLevenshteinSimilarity('hello', 'hello'), 1);
});

test('Levenshtein similarity: completely different returns low score', () => {
  const s = calculateLevenshteinSimilarity('abc', 'xyz');
  assert.ok(s < 0.5, `expected < 0.5, actual ${s}`);
});

test('Levenshtein similarity: near-identical strings return high score', () => {
  // Change one char, length 10 → similarity ≈ 0.9
  const s = calculateLevenshteinSimilarity('hello world', 'hello world!');
  assert.ok(s >= 0.9, `expected ≥ 0.9, actual ${s}`);
});

test('Levenshtein similarity: two empty strings return 1.0', () => {
  assert.equal(calculateLevenshteinSimilarity('', ''), 1);
});

test('Levenshtein similarity: empty vs non-empty returns 0', () => {
  assert.equal(calculateLevenshteinSimilarity('', 'abc'), 0);
});

test('Levenshtein similarity: non-string types return 0', () => {
  assert.equal(calculateLevenshteinSimilarity(null, 'x'), 0);
  assert.equal(calculateLevenshteinSimilarity(123, 'x'), 0);
});

// ============================================================
// detectSimilarPairs: find pairs above threshold across multiple reports
// ============================================================

test('detectSimilarPairs: 3 of 5 reports highly similar → returns those 3 ids', () => {
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
    assert.ok(result.cluster_ids.includes(id), `id=${id} should be in cluster`);
  }
});

test('detectSimilarPairs: none are similar → has_cluster=false', () => {
  const reports = [
    { id: 1, title: 'A', description: 'aaa' },
    { id: 2, title: 'B', description: 'bbb' },
    { id: 3, title: 'C', description: 'ccc' },
  ];
  const result = detectSimilarPairs(reports, 0.8);
  assert.equal(result.has_cluster, false);
});

// ============================================================
// detectSpam: combines three rules, returns trigger result
// ============================================================

test('detectSpam rule 1: 1h 5 reports + 3 similar → high_volume_1h + similar_content', async () => {
  // mock DB returns 5 reports within 1h, 3 of them with identical content
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

test('detectSpam rule 2: 24h 30 reports → high_volume_24h', async () => {
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
      // only 2 reports within 1h, does not trigger rule 1
      return { rows: reports30.slice(-2) };
    }
    return { rows: [] };
  };
  const r = await detectSpam(mockQuery, 1);
  assert.ok(r.triggered);
  assert.equal(r.trigger_rule, 'high_volume_24h');
  assert.equal(r.report_ids.length, 30);
});

test('detectSpam rule 3: 1h same fingerprint 5 reports → repeated_fingerprint', async () => {
  // Note: the interface layer already blocks at 3 reports, so this case is rare in practice, but the detector still needs to catch it
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

test('detectSpam: nothing triggers → triggered=false', async () => {
  const mockQuery = async () => ({ rows: [] });
  const r = await detectSpam(mockQuery, 1);
  assert.equal(r.triggered, false);
});

test('detectSpam: 1h 4 reports (not yet 5) → does not trigger', async () => {
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
