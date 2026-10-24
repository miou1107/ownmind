import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInstallPrompt } from '../client/src/utils/install-prompt.js';

/**
 * The install message exists in five places: the admin console button (install-prompt.js), the
 * three READMEs and the public site. They must all send the AI to the OwnMind server's manual
 * and install scripts, and none may fall back to the old raw-file one-liners that need git.
 */

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const strings = JSON.parse(read('docs/site/strings.json'));
const SURFACES = {
  'README.md': read('README.md'),
  'docs/README.zh-TW.md': read('docs/README.zh-TW.md'),
  'docs/README.ja.md': read('docs/README.ja.md'),
  'site en box2Prompt': strings.en.box2Prompt,
  'site zh-TW box2Prompt': strings['zh-TW'].box2Prompt,
  'site ja box2Prompt': strings.ja.box2Prompt,
};

// What the console button produces when the key and URL are the documentation placeholders.
const consolePrompt = buildInstallPrompt({ api_key: 'YOUR_API_KEY' }, 'YOUR_API_URL');
const [macLine] = consolePrompt.split('\n').filter((l) => l.startsWith('curl '));
const winLine = consolePrompt.split('\n').find((l) => l.startsWith('$env:'));

describe('install message surfaces', () => {
  for (const [name, text] of Object.entries(SURFACES)) {
    it(`${name} sends the AI to the server's manual and install scripts`, () => {
      assert.ok(text.includes('YOUR_API_URL/install-manual.md'), 'manual');
      assert.ok(text.includes('YOUR_API_URL/install.sh'), 'install.sh');
      assert.ok(text.includes('YOUR_API_URL/install.ps1'), 'install.ps1');
    });

    it(`${name} carries the same two one-liners as the console button`, () => {
      assert.ok(text.includes(macLine), macLine);
      assert.ok(text.includes(winLine), winLine);
    });

    it(`${name} no longer points at the raw install scripts in the public repository`, () => {
      assert.doesNotMatch(text, /raw\.githubusercontent\.com\/miou1107\/ownmind\/main\/install\.(sh|ps1)/);
      assert.doesNotMatch(text, /raw\.githubusercontent\.com\/miou1107\/ownmind\/main\/scripts\/bootstrap\.(sh|ps1)/);
    });

    it(`${name} tells the AI what to do with NEXT, FIX and ASK`, () => {
      for (const word of ['NEXT', 'FIX', 'ASK']) assert.ok(text.includes(word), word);
    });
  }

  it('the Chinese README and the Chinese site message are the console button text, placeholders and all', () => {
    // The README block sits under a list item: two spaces of indent on every non-empty line.
    const indented = consolePrompt.split('\n').map((l) => (l ? `  ${l}` : l)).join('\n');
    assert.ok(SURFACES['docs/README.zh-TW.md'].includes(indented));
    assert.equal(strings['zh-TW'].box2Prompt, consolePrompt);
  });

  it('the Japanese README and site message state the same rules in Japanese', () => {
    for (const text of [SURFACES['docs/README.ja.md'], strings.ja.box2Prompt]) {
      assert.match(text, /まず YOUR_API_URL\/install-manual\.md を読み/, 'read the manual first');
      assert.match(text, /一度だけ実行/, 'run once');
      assert.match(text, /NEXT が出たら NEXT の指示に従い/);
      assert.match(text, /FIX が出たら FIX の行のコマンドを先に実行してからインストールコマンドをもう一度実行/);
      assert.match(text, /ASK が出たときだけ私に聞いてください/, 'ASK only');
      assert.match(text, /どこを押すか一つずつ教えてください/, 'permissions one step at a time');
      assert.match(text, /手動でインストールさせないでください/, 'no manual installs');
    }
  });

  it('the English README and site message state the same rules in English', () => {
    for (const text of [SURFACES['README.md'], strings.en.box2Prompt]) {
      assert.match(text, /First read YOUR_API_URL\/install-manual\.md and follow the manual/);
      assert.match(text, /run it once/);
      assert.match(text, /If the output shows NEXT/);
      assert.match(text, /one step at a time/);
      assert.match(text, /handles every dependency itself/);
    }
  });
});
