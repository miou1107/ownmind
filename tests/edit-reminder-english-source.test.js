import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderEditReminderLine, WINDOW_MS, windowKey } from '../shared/edit-reminder-state.js';
import { editReminder } from '../hooks/ownmind-edit-reminder.js';
import { tempDir } from './helpers/temp-dir.js';

/**
 * v1.26.161 — OwnMind's own words on the edit path, in English at the source.
 *
 * The v1.26.0 hooks i18n pass covered `hooks/*.js` comments and four stray strings. It did not
 * reach the edit reminder's own text, and `shared/` was never in its scope at all. So three
 * surfaces are still Chinese in the source:
 *
 *   `· 本小時第 N 次`                          appended to the line the model is told to translate
 *   `AI 改檔案要遵守的鐵律 N 條`                the banner header
 *   `完整清單每小時列一次…`                     the banner footer
 *   `（OwnMind 無法寫入 ~/.ownmind/state/…）`   the state-write failure notice
 *
 * The first one is the sharp end: it is glued onto a line whose entire purpose is that the model
 * renders it in the user's language. Half of it arriving pre-translated into one specific
 * language is not a style preference, it is the line contradicting its own instruction.
 *
 * Rule titles are the exception and stay exactly as the user wrote them. They are user data;
 * neither i18n track has ever covered them.
 */

/**
 * CJK, not just Han: kana and hangul would otherwise pass a check whose whole claim is that no
 * CJK source string is left. Fullwidth forms are in because the strings this replaced used
 * `（）「」`, and a rewrite that kept the brackets and translated the words would slip through a
 * letters-only pattern.
 */
const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/;

describe('v1.26.161 — the edit path speaks English at the source', () => {
  it('the throttled line carries no Chinese', () => {
    const line = renderEditReminderLine('1.26.161', 71, 3);

    assert.doesNotMatch(line, CJK, `still CJK in the source: ${line}`);
    assert.match(line, /71/, 'the count is the content — it must survive the rewrite');
    assert.match(line, /3/, 'so must the occurrence');
  });

  it('the throttled line still identifies itself as OwnMind and names the version', () => {
    const line = renderEditReminderLine('1.26.161', 71, 3);

    assert.match(line, /OwnMind/);
    assert.match(line, /1\.26\.161/);
  });

  /**
   * English at the source is only half the contract. The other half is an instruction telling
   * the model to put it into the user's language — without it, translating a Chinese string to
   * English leaves a Chinese reader strictly worse off than before it was touched.
   *
   * This is the path with no network call and no counts in the window: a legacy server, second
   * edit of the hour. It emits `renderEditReminderLine` on its own, and nothing else.
   */
  describe('an English string never goes out without something to translate it', () => {
    let home;
    let statePath;
    let saved;

    beforeEach(() => {
      home = tempDir('ownmind-english-source-');
      statePath = path.join(home, 'edit-reminder.json');
      saved = process.env.__OWNMIND_EDIT_REMINDER_PATH;
      process.env.__OWNMIND_EDIT_REMINDER_PATH = statePath;
    });

    after(() => {
      if (saved === undefined) delete process.env.__OWNMIND_EDIT_REMINDER_PATH;
      else process.env.__OWNMIND_EDIT_REMINDER_PATH = saved;
      if (home) fs.rmSync(home, { recursive: true, force: true });
    });

    it('the throttled legacy line carries the relay instruction', async () => {
      const now = Date.now();
      // A window written by the legacy path: a rule count, and deliberately no per-category
      // counts, which is what `ctx.legacy` stores.
      fs.writeFileSync(statePath, JSON.stringify({
        sessions: {
          [windowKey('s', 'edit')]: {
            window_start_ms: now - (WINDOW_MS / 2), occurrence: 1, rule_count: 12,
          },
        },
      }));

      const out = await editReminder({
        version: '1.26.161', apiKey: 'k', apiUrl: 'http://127.0.0.1:1', now, sessionId: 's',
      });
      const context = JSON.parse(out).hookSpecificOutput.additionalContext;

      assert.match(context, /Iron rules the AI must follow: 12/, 'the legacy line is what goes out');
      assert.match(
        context, /translated into the language you are speaking with them/i,
        'English with nothing to translate it is a regression for the reader it replaced',
      );
    });
  });

  it('the hook module holds no Chinese of its own', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

    for (const rel of ['hooks/ownmind-edit-reminder.js', 'shared/edit-reminder-state.js']) {
      const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      const offenders = src
        .split('\n')
        .map((text, i) => ({ line: i + 1, text }))
        .filter(({ text }) => CJK.test(text));

      assert.deepEqual(
        offenders, [],
        `${rel} still has CJK in the source:\n`
        + offenders.map(o => `  ${rel}:${o.line}  ${o.text.trim()}`).join('\n'),
      );
    }
  });
});
