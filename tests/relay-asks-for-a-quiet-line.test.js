import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderHookContextLine } from '../shared/hook-context.js';

/**
 * v1.26.161 — the relayed line has to say how it should look.
 *
 * The relay instruction asks the model to translate the line and keep the numbers verbatim, and
 * says nothing about presentation. So the model prints it as body text, in the same weight as
 * the answer the user actually asked for, in front of every operation.
 *
 * What the renderer supports was measured rather than assumed (Claude Code, 2026-08-13):
 *
 *   <sub> / <small>   nothing happens — a terminal markdown renderer has no font sizes
 *   `inline code`     works, and takes a theme accent colour: it comes out LOUDER
 *   *italic*          works, no colour change
 *   > blockquote      works, dimmed with a rule down the left
 *
 * So blockquote + italic is the combination, and it is the instruction's job to ask for it —
 * not the string's. Putting the markdown in the line itself would make every caller carry it,
 * including the throttled path that appends its own suffix to the same string.
 */

const COUNTS = { team_standard: 1, iron_rule: 9, coding_standard: 0, principle: 0, profile: 0 };
const TOTALS = { team_standard: 32, iron_rule: 150, coding_standard: 33, principle: 92, profile: 14 };

describe('v1.26.161 — the relay instruction asks for a line that recedes', () => {
  it('names the blockquote and the italics on the full listing', () => {
    const out = renderHookContextLine({
      version: '1.26.161',
      trigger: 'send',
      counts: COUNTS,
      totals: TOTALS,
      names: { team_standard: ['review before anything leaves'] },
      withHowTo: true,
    });

    assert.match(out, /blockquote/i, 'the model has to be told which form to use');
    assert.match(out, /italic/i);
    assert.match(out, /> \*/, 'showing the literal markdown removes the guesswork');
  });

  it('names it on the throttled shape too', () => {
    const out = renderHookContextLine({ version: '1.26.161', trigger: 'edit', counts: COUNTS });

    assert.match(out, /blockquote/i, 'the two forms are the same line to the reader');
    assert.match(out, /italic/i);
  });

  it('still asks for translation and for the numbers to survive it', () => {
    const out = renderHookContextLine({ version: '1.26.161', trigger: 'edit', counts: COUNTS });

    assert.match(out, /translated into the language/i, 'the presentation must not displace this');
    assert.match(out, /exactly as written/i);
  });

  it('puts a suffix inside the line, before the instruction', () => {
    // The throttled edit path used to build `${contextLine} · occurrence 2 this hour`, which put
    // the occurrence AFTER the paragraph that names what must survive translation. A model
    // following that instruction faithfully drops the occurrence — and the occurrence is the
    // only thing telling the reader that a one-line reminder, where a list stood a minute ago,
    // is a throttle rather than a breakage.
    const out = renderHookContextLine({
      version: '1.26.161',
      trigger: 'edit',
      counts: COUNTS,
      suffix: ' · occurrence 2 this hour',
    });

    const [first, ...rest] = out.split('\n');
    assert.match(first, / · occurrence 2 this hour$/, 'the suffix belongs to the line');
    assert.doesNotMatch(
      rest.join('\n'), /occurrence 2/,
      'not after the instruction paragraph, where it reads as something the model may drop',
    );
  });

  it('names the occurrence among the parts that must survive translation', () => {
    const out = renderHookContextLine({ version: '1.26.161', trigger: 'edit', counts: COUNTS });

    assert.match(out, /Keep the counts, the occurrence and the version tag exactly as written/i);
  });

  it('says nothing at all when every category is zero', () => {
    const out = renderHookContextLine({
      version: '1.26.161',
      trigger: 'edit',
      counts: { team_standard: 0, iron_rule: 0, coding_standard: 0, principle: 0, profile: 0 },
    });

    assert.equal(out, '', 'a formatting instruction attached to nothing is still nothing');
  });
});
