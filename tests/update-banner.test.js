// v1.26.129 — the background update stops being silent.
//
// It already ran on its own and wrote its outcome to the local event log only. From the
// user's side a failing update looked exactly like an up-to-date machine, and kept looking
// that way for as long as it kept failing.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildUpdateBanner,
  queueUpdateBanner,
  readUpdateNotices,
  clearDeliveredUpdateNotices,
} from '../shared/update-banner.js';
import { tempDir } from './helpers/temp-dir.js';

let home;
const pendingFile = () => path.join(home, '.ownmind', 'logs', 'update-pending.jsonl');
const records = () => fs.readFileSync(pendingFile(), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

beforeEach(() => { home = tempDir('om-banner-'); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('buildUpdateBanner', () => {
  it('says the version and that there is nothing to do', () => {
    const block = buildUpdateBanner({ outcome: 'applied', version: '1.26.129' });
    assert.match(block, /1\.26\.129/);
    assert.match(block, /升級成功/);
    assert.match(block, /不需做任何處理/);
  });

  it('offers to report the failure, because the user cannot fix it themselves', () => {
    // The update runs in a detached child. Surfacing the failure without a way to act on it
    // would just be a worry with no exit.
    const block = buildUpdateBanner({ outcome: 'failed', step: 'pull' });
    assert.match(block, /失敗/);
    assert.match(block, /回報 ownmind bug/);
  });

  it('names the step in words rather than in the updater\'s vocabulary', () => {
    assert.match(buildUpdateBanner({ outcome: 'failed', step: 'npm' }), /安裝套件/);
    assert.match(buildUpdateBanner({ outcome: 'failed', step: 'fetch' }), /連不上/);
  });

  it('still reports a step it has no label for', () => {
    // Dropping the unknown case would mean a whole class of failures going quiet — which is
    // the exact behaviour this file exists to end.
    const block = buildUpdateBanner({ outcome: 'failed', step: 'some_new_step' });
    assert.match(block, /some_new_step/);
    assert.match(block, /回報 ownmind bug/);
  });

  it('says nothing when there was no new version', () => {
    // Silence has to keep meaning "nothing happened", or the message stops being read.
    assert.equal(buildUpdateBanner({ outcome: 'clean' }), null);
  });

  it('says nothing about a success whose version it could not read', () => {
    // "已更新到 ? 版" is worse than silence — the next session would show a message that
    // tells the user nothing and makes the product look broken at the moment it worked.
    assert.equal(buildUpdateBanner({ outcome: 'applied', version: '?' }), null);
    assert.equal(buildUpdateBanner({ outcome: 'applied' }), null);
  });
});

describe('queueUpdateBanner', () => {
  it('writes one JSON Lines record the Stop hook can read', () => {
    assert.equal(queueUpdateBanner({ outcome: 'applied', version: '1.26.129', homeDir: home }), true);
    const rows = records();
    assert.equal(rows.length, 1);
    assert.match(rows[0].block, /1\.26\.129/);
    assert.equal(rows[0].source, 'auto_update');
  });

  it('keeps a multi-line failure message on one line of the file', () => {
    // The reader parses per line. A raw newline would split one message into two lines, the
    // second of which is not JSON, and broken lines are skipped — so the user would
    // silently get half a message.
    queueUpdateBanner({ outcome: 'failed', step: 'pull', homeDir: home });
    const raw = fs.readFileSync(pendingFile(), 'utf8').trimEnd();
    assert.equal(raw.split('\n').length, 1);
    assert.match(JSON.parse(raw).block, /\n/);
  });

  it('appends rather than replacing what is already queued', () => {
    queueUpdateBanner({ outcome: 'failed', step: 'fetch', homeDir: home });
    queueUpdateBanner({ outcome: 'applied', version: '1.26.129', homeDir: home });
    assert.equal(records().length, 2);
  });

  it('creates the log directory when the machine has never written one', () => {
    assert.ok(!fs.existsSync(path.join(home, '.ownmind', 'logs')));
    assert.equal(queueUpdateBanner({ outcome: 'applied', version: '1.26.129', homeDir: home }), true);
    assert.ok(fs.existsSync(pendingFile()));
  });

  it('writes nothing, and does not throw, when there is nothing to say', () => {
    assert.equal(queueUpdateBanner({ outcome: 'clean', homeDir: home }), false);
    assert.ok(!fs.existsSync(pendingFile()));
  });

  it('reports false instead of throwing when the path cannot be written', () => {
    // This runs at the tail of an update that already finished. Throwing here would turn a
    // reportable outcome into no outcome.
    const blocked = path.join(home, 'blocked');
    fs.writeFileSync(blocked, 'not a directory');
    assert.equal(
      queueUpdateBanner({ outcome: 'applied', version: '1.26.129', homeDir: blocked }),
      false,
    );
  });
});

describe('readUpdateNotices / clearDeliveredUpdateNotices', () => {
  it('reads back what was queued, oldest first', () => {
    queueUpdateBanner({ outcome: 'failed', step: 'pull', homeDir: home });
    queueUpdateBanner({ outcome: 'applied', version: '1.26.129', homeDir: home });
    const { blocks, lineCount } = readUpdateNotices({ homeDir: home });
    assert.equal(lineCount, 2);
    assert.match(blocks[0], /\u66f4\u65b0\u5931\u6557/);
    assert.match(blocks[1], /1\.26\.129/);
  });

  it('reports nothing on a machine that has never queued anything', () => {
    const { blocks, lineCount } = readUpdateNotices({ homeDir: home });
    assert.deepEqual(blocks, []);
    assert.equal(lineCount, 0);
  });

  it('counts an unreadable line even though it cannot show it', () => {
    // Drain is by position. A skipped line that did not occupy one would shift the slice and
    // delete the next record — an outcome nobody ever saw.
    fs.mkdirSync(path.dirname(pendingFile()), { recursive: true });
    fs.writeFileSync(pendingFile(), '{ this is half a record\n');
    queueUpdateBanner({ outcome: 'applied', version: '1.26.129', homeDir: home });
    const { blocks, lineCount } = readUpdateNotices({ homeDir: home });
    assert.equal(blocks.length, 1);
    assert.equal(lineCount, 2);
  });

  it('removes the file once everything queued has been delivered', () => {
    queueUpdateBanner({ outcome: 'applied', version: '1.26.129', homeDir: home });
    const { lineCount } = readUpdateNotices({ homeDir: home });
    assert.equal(clearDeliveredUpdateNotices({ deliveredCount: lineCount, homeDir: home }), true);
    assert.ok(!fs.existsSync(pendingFile()));
  });

  it('keeps an outcome that arrived after the read — draining must not truncate', () => {
    // The updater runs detached and can append at any moment, including between the Stop
    // hook reading the queue and clearing it. Truncating here would delete an outcome that
    // was never shown to anybody, which is the exact failure this queue exists to end.
    queueUpdateBanner({ outcome: 'failed', step: 'fetch', homeDir: home });
    const { lineCount } = readUpdateNotices({ homeDir: home });
    queueUpdateBanner({ outcome: 'applied', version: '1.26.173', homeDir: home });
    clearDeliveredUpdateNotices({ deliveredCount: lineCount, homeDir: home });
    const after = readUpdateNotices({ homeDir: home });
    assert.equal(after.blocks.length, 1);
    assert.match(after.blocks[0], /1\.26\.173/);
  });

  it('does nothing when asked to drain zero', () => {
    queueUpdateBanner({ outcome: 'applied', version: '1.26.129', homeDir: home });
    assert.equal(clearDeliveredUpdateNotices({ deliveredCount: 0, homeDir: home }), false);
    assert.equal(readUpdateNotices({ homeDir: home }).blocks.length, 1);
  });
});
