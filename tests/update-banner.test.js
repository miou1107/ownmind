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
import { buildUpdateBanner, queueUpdateBanner } from '../shared/update-banner.js';
import { tempDir } from './helpers/temp-dir.js';

let home;
const pendingFile = () => path.join(home, '.ownmind', 'logs', 'banner-pending.jsonl');
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
  it('writes one JSON Lines record the flusher can read', () => {
    assert.equal(queueUpdateBanner({ outcome: 'applied', version: '1.26.129', homeDir: home }), true);
    const rows = records();
    assert.equal(rows.length, 1);
    assert.match(rows[0].block, /1\.26\.129/);
    assert.equal(rows[0].source, 'auto_update');
  });

  it('keeps a multi-line failure message on one line of the file', () => {
    // flush-pending-banners.js parses per line. A raw newline would split one message into
    // two lines, the second of which is not JSON, and the flusher skips broken lines — so
    // the user would silently get half a message.
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
