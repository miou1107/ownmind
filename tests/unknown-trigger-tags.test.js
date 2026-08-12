import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  unknownTriggerTags,
  unknownTriggerTagWarning,
  KNOWN_TRIGGER_WORDS,
  TRIGGER_TAG_ALIASES,
  ruleMatchesTrigger,
} from '../shared/helpers.js';

/**
 * v1.26.157 — the vocabulary had one reader, and it was the wrong end.
 *
 * `TRIGGER_TAG_ALIASES` was consulted only by `ruleMatchesTrigger`, at the moment a hook
 * decides what to show. Nothing looked at it when a memory was *written*. So a tag naming a
 * word no trigger asks for was stored, reported as saved, and never asked for again.
 *
 * Measured 2026-08-12 on the live account: nine memories carried such tags. One was a team
 * standard requiring an independent review before anything leaves; it had never fired in the
 * two weeks it had existed, and an issue was filed that afternoon without it appearing.
 *
 * The author saw a tag they had written. The reader saw a category count that was merely
 * lower than it should have been. Neither end of the system could see the fault, which is why
 * it survived — and why the fix belongs at the moment of writing, when someone is still
 * looking.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

describe('v1.26.157 — a trigger tag nothing asks for is said out loud', () => {
  it('flags the tags actually found on the live account', () => {
    // Verbatim from the 2026-08-12 sweep. Each of these named a kind of work rather than an
    // operation, so no trigger ever asked for it.
    const found = [
      'trigger:wrap-up', 'trigger:handoff', 'trigger:bug', 'trigger:debug',
      'trigger:save', 'trigger:learn', 'trigger:architecture', 'trigger:gitlab',
      'trigger:reply', 'trigger:language', 'trigger:身分',
    ];
    assert.deepEqual(unknownTriggerTags(found), found, 'every one of these is unreachable');
  });

  it('accepts every word the matcher actually honours', () => {
    // The two must agree by construction: a word this check calls unknown while
    // ruleMatchesTrigger honours it would be a warning about a tag that works.
    for (const [trigger, words] of Object.entries(TRIGGER_TAG_ALIASES)) {
      for (const word of words) {
        const tag = `trigger:${word}`;
        assert.deepEqual(unknownTriggerTags([tag]), [], `${tag} is honoured for ${trigger}`);
        assert.equal(ruleMatchesTrigger({ tags: [tag] }, trigger), true,
          `${tag} must still match ${trigger}`);
      }
    }
  });

  it('accepts the canonical trigger names and the catch-all', () => {
    for (const name of Object.keys(TRIGGER_TAG_ALIASES)) {
      assert.deepEqual(unknownTriggerTags([`trigger:${name}`]), []);
    }
    assert.deepEqual(unknownTriggerTags(['trigger:command']), [],
      'trigger:command is accepted for every trigger — see ruleMatchesTrigger');
  });

  it('matches the way tags are matched: case-insensitively', () => {
    assert.deepEqual(unknownTriggerTags(['trigger:DEPLOY', 'TRIGGER:Commit']), [],
      'ruleMatchesTrigger lowercases, so this must not warn about a tag that works');
  });

  it('leaves every other tag alone', () => {
    // Ordinary labels are used for search and grouping. They have no vocabulary to be wrong
    // about, and judging them would break how tags have always been used.
    const labels = ['security', 'git', 'workflow', 'auto_created', 'ownmind', '決定'];
    assert.deepEqual(unknownTriggerTags(labels), []);
  });

  it('survives the shapes a caller can actually send', () => {
    assert.deepEqual(unknownTriggerTags(undefined), []);
    assert.deepEqual(unknownTriggerTags(null), []);
    assert.deepEqual(unknownTriggerTags('trigger:nope'), [], 'a bare string is not a tag list');
    assert.deepEqual(unknownTriggerTags([null, 7, {}, 'trigger:nope']), ['trigger:nope']);
  });

  it('reports the offending tags verbatim, in the order given', () => {
    // The author has to be able to find the tag they typed. Normalising it in the message
    // would send them looking for a string they never wrote.
    const given = ['trigger:Wrap-Up', 'trigger:commit', 'trigger:收工'];
    assert.deepEqual(unknownTriggerTags(given), ['trigger:Wrap-Up', 'trigger:收工']);
  });
});

describe('v1.26.157 — what the warning says', () => {
  const text = unknownTriggerTagWarning(['trigger:收工', 'trigger:bye']);

  it('names the tags it is about', () => {
    assert.match(text, /trigger:收工/);
    assert.match(text, /trigger:bye/);
  });

  it('says what will happen, not merely that something is wrong', () => {
    // Usually nothing is wrong: a memory found by name needs no trigger tag, and seven of the
    // nine found on 2026-08-12 were deliberately left that way. What the author cannot
    // otherwise discover is that the tag buys them nothing.
    assert.match(text, /不會.*自動跳出來/);
  });

  it('lists the triggers that do exist, so the author can pick one', () => {
    for (const name of Object.keys(TRIGGER_TAG_ALIASES)) {
      assert.match(text, new RegExp(name), `the author needs to see ${name} as an option`);
    }
    assert.match(text, /command/);
  });

  it('says that no tag at all is a legitimate answer', () => {
    assert.match(text, /可以不加/);
  });
});

describe('v1.26.157 — both write paths carry the check', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src', 'routes', 'memory.js'), 'utf8');

  it('create attaches it', () => {
    const start = src.indexOf("router.post('/'");
    const end = src.indexOf("router.get('/search'", start);
    const block = start < end && start > 0 ? src.slice(start, end) : src.slice(start);
    assert.match(block, /unknownTriggerTags\(tags\)/);
  });

  it('update attaches it too', () => {
    // `tags` REPLACES rather than merges on this route, so an update is exactly where a
    // working tag gets dropped or a dead one introduced — and it is the path the tagging
    // work of 2026-08-12 went through.
    const start = src.indexOf("router.put('/:id'");
    assert.ok(start > 0, 'the update route moved');
    assert.match(src.slice(start), /unknownTriggerTags\(tags\)/);
  });

  it('warns rather than refuses', () => {
    // Rejecting would make the seven deliberately-untagged memories uneditable for any
    // unrelated reason, which is a worse failure than the one being fixed.
    assert.doesNotMatch(src, /unknownTriggerTags[\s\S]{0,200}res\.status\(4\d\d\)/);
  });
});

describe('v1.26.157 — the vocabulary is derived, never restated', () => {
  it('every known word comes from the alias table itself', () => {
    // A hand-written second list is the defect this release is about, one level up: it would
    // drift from the table and start warning about tags that work.
    const derived = new Set([
      'command',
      ...Object.keys(TRIGGER_TAG_ALIASES),
      ...Object.values(TRIGGER_TAG_ALIASES).flat(),
    ].map((w) => w.toLowerCase()));
    assert.deepEqual([...KNOWN_TRIGGER_WORDS].sort(), [...derived].sort());
  });
});
