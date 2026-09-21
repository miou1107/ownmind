import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * bootstrap.ps1 must not ship a BOM (#99)
 *
 * With `iwr -useb <url>/bootstrap.ps1 | iex`, the response decodes to a string whose first
 * character is U+FEFF. PowerShell 5.1 treats that character as part of the first token, so the
 * one-liner opens with a red CommandNotFoundException on `﻿#`. Reproduced on 5.1 by decoding the
 * file's bytes as UTF-8 and passing the string to Invoke-Expression.
 *
 * v1.17.10 stripped the BOM in src/app.js, which covers the copy this server hands out. It does
 * not cover the copy README tells people to fetch: both README and the translated READMEs point
 * at raw.githubusercontent.com, which serves the file byte for byte. So the BOM had to come off
 * the file itself.
 *
 * v1.17.9 kept the BOM on purpose, because Windows PowerShell 5.1 reads a BOM-less .ps1 in the
 * system codepage and CP950 mangles UTF-8 Chinese. That reason is gone: the four Chinese comments
 * in bootstrap.ps1 are English now (CLAUDE.md track B), the file is pure ASCII, and ASCII reads
 * identically under either codepage. The ASCII assertion below is what keeps the two facts tied
 * together — put Chinese back in this file and the test fails, telling you the BOM question is
 * open again rather than letting you rediscover it on a Traditional-Chinese machine.
 *
 * tests/ps1-utf8-bom.test.js still requires a BOM on every .ps1 that contains Chinese; this file
 * is not one of them, so the two rules agree.
 *
 * The src/app.js strip stays asserted below: it is the second line of defence for anyone who
 * fetches through this server, and it costs nothing on a BOM-less string.
 */

describe('bootstrap.ps1 BOM', () => {
  const ps1Path = path.join(repoRoot, 'scripts', 'bootstrap.ps1');
  const ps1Bytes = fs.readFileSync(ps1Path);
  const appJs = fs.readFileSync(path.join(repoRoot, 'src', 'app.js'), 'utf8');

  it('the file on disk starts with no BOM, so the documented one-liner runs', () => {
    const head = [...ps1Bytes.subarray(0, 3)];
    assert.notDeepEqual(
      head,
      [0xef, 0xbb, 0xbf],
      'bootstrap.ps1 starts with a UTF-8 BOM again; `iwr | iex` will fail with CommandNotFoundException'
    );
    assert.equal(ps1Bytes[0], 0x23, 'bootstrap.ps1 should start with the "#" of its header comment');
  });

  it('the file is pure ASCII, which is why dropping the BOM is safe on PowerShell 5.1', () => {
    const offenders = [];
    for (let i = 0; i < ps1Bytes.length; i++) {
      if (ps1Bytes[i] > 0x7f) {
        offenders.push(i);
        if (offenders.length >= 5) break;
      }
    }
    assert.equal(
      offenders.length,
      0,
      `bootstrap.ps1 has non-ASCII bytes at offsets ${offenders.join(', ')}. ` +
        'Either translate them to English, or restore the BOM and accept that the ' +
        'raw.githubusercontent.com one-liner breaks again (#99).'
    );
  });

  it('src/app.js still strips a leading U+FEFF from the copy it serves', () => {
    const hasStrip = /stripBom|replace\(\s*\/\^\\uFEFF\/|0xFEFF|0xfeff/.test(appJs);
    assert.ok(hasStrip, 'src/app.js no longer strips the BOM from bootstrapPs1');

    const stripsPs1 =
      /stripBom\(\s*readFileSync[^)]+bootstrap\.ps1/.test(appJs) ||
      /stripBom\(bootstrapPs1\)/.test(appJs) ||
      /bootstrapPs1\s*=\s*[^;]+(stripBom|replace\(\s*\/\^\\u?FEFF)/.test(appJs);
    assert.ok(stripsPs1, 'bootstrapPs1 must still go through the BOM strip');
  });
});
