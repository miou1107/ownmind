/**
 * v1.19.11 — pure-function tests for lint-event-logger.
 *
 * Maps to openspec/changes/v1.19.11-lint-ux-improvements/spec.md scenarios 10-14.
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

describe('v1.19.11 scenario 10 — writeEvent records one entry', () => {
  it('after write, file exists with one JSON entry', () => {
    // v1.20.4: ruleCodes switched to neutral event constants, violated_words fields are neutral too.
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

  it('multiple consecutive writes append (no overwrite)', () => {
    writeEvent({ sessionId: 'a', event: 'blocked', ruleCodes: ['lint_jargon_explanation_required'] });
    writeEvent({ sessionId: 'b', event: 'blocked', ruleCodes: ['lint_language_mixed_ratio'] });
    const lines = fs.readFileSync(tmpPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).session_id, 'a');
    assert.equal(JSON.parse(lines[1]).session_id, 'b');
  });

  it('missing fields get defaults', () => {
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

describe('v1.19.11 scenario 11 — rotate mechanism', () => {
  it('file over 5MB → renamed to .old, new write goes into a fresh file', () => {
    // Write a > 5MB fake file.
    const padding = 'x'.repeat(6 * 1024 * 1024);
    fs.writeFileSync(tmpPath, padding);

    writeEvent({ sessionId: 'after-rotate', event: 'blocked', ruleCodes: ['lint_jargon_explanation_required'] });

    // The old file should be renamed to .old.
    assert.equal(fs.existsSync(tmpPath + '.old'), true);

    // The new file should exist and contain exactly one entry.
    const newContent = fs.readFileSync(tmpPath, 'utf8').trim();
    const lines = newContent.split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).session_id, 'after-rotate');
  });
});

describe('v1.19.11 scenario 12 — write failure does not throw', () => {
  it('writing to an unwritable path returns false without throwing', () => {
    _resetPathForTests('/root/no-permission/x.jsonl');
    let didThrow = false;
    let result;
    try {
      result = writeEvent({ sessionId: 's', event: 'blocked' });
    } catch { didThrow = true; }
    assert.equal(didThrow, false, 'must not throw');
    assert.equal(result, false, 'write failure should return false');
  });

  it('entry is null → returns false, does not throw', () => {
    const result = writeEvent(null);
    assert.equal(result, false);
  });
});

describe('v1.19.11 — pure-function extractViolatedWords', () => {
  // v1.20.4: violations rule uses neutral event constants, output fields are neutral too.
  it('extracts mixedWords from the mixed-language event', () => {
    const out = extractViolatedWords([
      { rule: 'lint_language_mixed_ratio', detail: { mixedWords: ['refactor', 'codebase'] } },
    ]);
    assert.deepEqual(out.mixed_lang_words, ['refactor', 'codebase']);
  });

  it('extracts jargon from the jargon event', () => {
    const out = extractViolatedWords([
      { rule: 'lint_jargon_explanation_required', detail: { jargon: ['routes', 'middleware'] } },
    ]);
    assert.deepEqual(out.jargon_words, ['routes', 'middleware']);
  });

  it('privacy_check does not store the original value, only type counts', () => {
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
    // Must not contain the original value.
    const serialized = JSON.stringify(out);
    assert.equal(serialized.includes('a@b.com'), false);
    assert.equal(serialized.includes('A123456789'), false);
  });

  it('extracts from multiple violations at once', () => {
    const out = extractViolatedWords([
      { rule: 'lint_language_mixed_ratio', detail: { mixedWords: ['a'] } },
      { rule: 'lint_jargon_explanation_required', detail: { jargon: ['b'] } },
    ]);
    assert.deepEqual(out.mixed_lang_words, ['a']);
    assert.deepEqual(out.jargon_words, ['b']);
  });

  it('caps at 20 words; anything more is truncated', () => {
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`);
    const out = extractViolatedWords([
      { rule: 'lint_language_mixed_ratio', detail: { mixedWords: words } },
    ]);
    assert.equal(out.mixed_lang_words.length, 20);
  });

  it('non-array input returns empty object', () => {
    assert.deepEqual(extractViolatedWords(null), {});
    assert.deepEqual(extractViolatedWords('abc'), {});
  });
});
