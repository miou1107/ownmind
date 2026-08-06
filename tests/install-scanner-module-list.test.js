import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * v1.26.71 — install.sh named five scanner modules by hand.
 *
 * The list was written on 2026-04-22 with the usage-tracking system and never touched
 * again. `shared/scanners/` has grown to eleven files since. The list has been wrong for
 * three and a half months and nothing said so, because a hand-written list does not fail
 * — it just quietly stops covering things.
 *
 * **Nobody was affected**, and how that was established is the more useful half. The
 * copy's source is `$OWNMIND_DIR/shared/scanners` and its destination is
 * `$HOME/.ownmind/shared/scanners`, and `OWNMIND_DIR` is `$HOME/.ownmind` — the same
 * directory. `safe_cp` compares with `-ef` and skips. Every one of those copies is a
 * no-op; what actually delivers the files is the `git clone`/`git pull` further up.
 *
 * Reading the list and concluding "six files are missing" took an hour to walk back,
 * because the check made to confirm it built the broken layout by hand rather than
 * looking at how the directory is really populated. The positive control was sitting
 * right there: collectors on several machines reporting daily.
 *
 * So this guards a copy that is currently unreachable. It is worth guarding anyway. The
 * block exists for the case where `OWNMIND_DIR` is not `~/.ownmind`, and on that day it
 * has to be right; and a stale list that looks authoritative costs whoever reads it next
 * exactly what it cost this time.
 */
describe('install.sh — the scanner module copy must not be a hand-written list', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'install.sh'), 'utf8');
  const onDisk = fs.readdirSync(path.join(repoRoot, 'shared', 'scanners'))
    .filter((f) => f.endsWith('.js'))
    .sort();

  const block = content.match(
    /mkdir -p "\$HOME\/\.ownmind\/shared\/scanners"[\s\S]{0,600}?\bdone\b/
  );

  it('has a copy block to check at all', () => {
    assert.ok(block, 'the scanner copy block in install.sh moved or changed shape');
  });

  it('covers every module in shared/scanners, however many there are', () => {
    assert.ok(onDisk.length > 5, 'sanity: the directory should hold more than the old list');

    // A glob covers the directory by construction and cannot go stale.
    if (/shared\/scanners\/\*\.js/.test(block[0])) return;

    // Otherwise it names files, and every one of them had better be named.
    const named = [...block[0].matchAll(/\b([a-z0-9-]+\.js)\b/g)].map((m) => m[1]);
    const missing = onDisk.filter((f) => !named.includes(f));
    assert.deepEqual(missing, [],
      `install.sh names scanner modules one by one and is missing ${missing.join(', ')}. `
      + 'Use a glob over shared/scanners/*.js instead: a list has to be remembered, and '
      + 'forgetting it produces no error.');
  });

  it('still guards against copying a file onto itself', () => {
    // The normal case is source === destination, so the copy must go through safe_cp
    // rather than a bare cp. Bob reported the noisy self-copy warnings in v1.17.10.
    assert.match(block[0], /safe_cp/,
      'the scanner copy must use safe_cp; a bare cp warns on every ordinary install');
  });
});
