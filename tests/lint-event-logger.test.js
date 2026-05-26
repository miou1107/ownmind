/**
 * v1.19.11 — lint-event-logger 純函式測試
 *
 * 對應 openspec/changes/v1.19.11-lint-ux-improvements/spec.md 場景 10-14。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  writeEvent,
  extractViolatedWords,
  _resetPathForTests,
} from '../hooks/lib/lint-event-logger.js';

let tmpPath;

beforeEach(() => {
  tmpPath = path.join(os.tmpdir(), `lint-event-test-${Date.now()}-${Math.random()}.jsonl`);
  _resetPathForTests(tmpPath);
});

afterEach(() => {
  try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  try { fs.unlinkSync(tmpPath + '.old'); } catch { /* ignore */ }
  _resetPathForTests(null);
});

describe('v1.19.11 場景 10 — writeEvent 寫一筆紀錄', () => {
  it('寫入後檔案存在、含一筆 JSON', () => {
    // v1.20.4：ruleCodes 改用中性事件常數、violated_words 欄位也改中性命名
    writeEvent({
      sessionId: 'sess-1',
      event: 'blocked',
      ruleCodes: ['lint_jargon_explanation_required', 'lint_language_mixed_ratio'],
      violatedWords: { jargon_words: ['routes'], mixed_lang_words: ['refactor'] },
      violationCountInSession: 4,
      blockCountInSession: 1,
      downgradedToWarning: false,
      aiInstructedToAnnotate: true,
    });
    const content = fs.readFileSync(tmpPath, 'utf8').trim();
    const parsed = JSON.parse(content);
    assert.equal(parsed.session_id, 'sess-1');
    assert.equal(parsed.event, 'blocked');
    assert.deepEqual(parsed.rule_codes, ['lint_jargon_explanation_required', 'lint_language_mixed_ratio']);
    assert.equal(parsed.violation_count_in_session, 4);
    assert.equal(parsed.block_count_in_session, 1);
    assert.equal(parsed.downgraded_to_warning, false);
    assert.equal(parsed.ai_instructed_to_annotate, true);
    assert.match(parsed.ts, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('連續寫多筆、append 不覆蓋', () => {
    writeEvent({ sessionId: 'a', event: 'blocked', ruleCodes: ['lint_jargon_explanation_required'] });
    writeEvent({ sessionId: 'b', event: 'blocked', ruleCodes: ['lint_language_mixed_ratio'] });
    const lines = fs.readFileSync(tmpPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).session_id, 'a');
    assert.equal(JSON.parse(lines[1]).session_id, 'b');
  });

  it('缺欄位有預設值', () => {
    writeEvent({ sessionId: 'x', event: 'blocked' });
    const parsed = JSON.parse(fs.readFileSync(tmpPath, 'utf8').trim());
    assert.deepEqual(parsed.rule_codes, []);
    assert.deepEqual(parsed.violated_words, {});
    assert.equal(parsed.violation_count_in_session, 0);
    assert.equal(parsed.block_count_in_session, 0);
    assert.equal(parsed.downgraded_to_warning, false);
    assert.equal(parsed.ai_instructed_to_annotate, false);
  });
});

describe('v1.19.11 場景 11 — rotate 機制', () => {
  it('檔大小超過 5MB → rename 成 .old、新寫入空檔', () => {
    // 寫一個 > 5MB 的假檔
    const padding = 'x'.repeat(6 * 1024 * 1024);
    fs.writeFileSync(tmpPath, padding);

    writeEvent({ sessionId: 'after-rotate', event: 'blocked', ruleCodes: ['lint_jargon_explanation_required'] });

    // 舊檔該被 rename 成 .old
    assert.equal(fs.existsSync(tmpPath + '.old'), true);

    // 新檔該存在且只有一筆紀錄
    const newContent = fs.readFileSync(tmpPath, 'utf8').trim();
    const lines = newContent.split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).session_id, 'after-rotate');
  });
});

describe('v1.19.11 場景 12 — 寫入失敗不丟', () => {
  it('寫無權限路徑、回 false 不丟', () => {
    _resetPathForTests('/root/no-permission/x.jsonl');
    let didThrow = false;
    let result;
    try {
      result = writeEvent({ sessionId: 's', event: 'blocked' });
    } catch { didThrow = true; }
    assert.equal(didThrow, false, '不該丟例外');
    assert.equal(result, false, '寫入失敗該回 false');
  });

  it('entry 為 null → 回 false 不丟', () => {
    const result = writeEvent(null);
    assert.equal(result, false);
  });
});

describe('v1.19.11 — extractViolatedWords 純函式', () => {
  // v1.20.4：violations rule 用中性事件常數、輸出欄位也用中性命名
  it('抽中英混雜事件的 mixedWords', () => {
    const out = extractViolatedWords([
      { rule: 'lint_language_mixed_ratio', detail: { mixedWords: ['refactor', 'codebase'] } },
    ]);
    assert.deepEqual(out.mixed_lang_words, ['refactor', 'codebase']);
  });

  it('抽行話事件的 jargon', () => {
    const out = extractViolatedWords([
      { rule: 'lint_jargon_explanation_required', detail: { jargon: ['routes', 'middleware'] } },
    ]);
    assert.deepEqual(out.jargon_words, ['routes', 'middleware']);
  });

  it('privacy_check 不存原值、只存類型計數', () => {
    const out = extractViolatedWords([
      {
        rule: 'privacy_check',
        detail: {
          matches: [
            { type: 'email', value: 'a@b.com' },
            { type: 'email', value: 'c@d.com' },
            { type: 'tw_id', value: 'A123456789' },
          ],
        },
      },
    ]);
    assert.equal(out.privacy_matches_count, 3);
    assert.deepEqual(out.privacy_types.sort(), ['email', 'tw_id']);
    // 不該含原 value
    const serialized = JSON.stringify(out);
    assert.equal(serialized.includes('a@b.com'), false);
    assert.equal(serialized.includes('A123456789'), false);
  });

  it('多違規同時抽', () => {
    const out = extractViolatedWords([
      { rule: 'lint_language_mixed_ratio', detail: { mixedWords: ['a'] } },
      { rule: 'lint_jargon_explanation_required', detail: { jargon: ['b'] } },
    ]);
    assert.deepEqual(out.mixed_lang_words, ['a']);
    assert.deepEqual(out.jargon_words, ['b']);
  });

  it('上限 20 個詞、超過截斷', () => {
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`);
    const out = extractViolatedWords([
      { rule: 'lint_language_mixed_ratio', detail: { mixedWords: words } },
    ]);
    assert.equal(out.mixed_lang_words.length, 20);
  });

  it('非陣列輸入回空物件', () => {
    assert.deepEqual(extractViolatedWords(null), {});
    assert.deepEqual(extractViolatedWords('abc'), {});
  });
});
