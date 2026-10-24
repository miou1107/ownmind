/**
 * buildInstallPrompt() emits the install message an admin pastes into a colleague's AI tool.
 *
 * Zero-touch install: the message no longer points at raw.githubusercontent.com. It tells the
 * AI to read the manual on the OwnMind server first, run the one-liner for the operating system
 * once, and follow the NEXT / FIX / ASK lines the installer prints.
 *
 * Extracted to a pure function so this test doesn't need a React renderer. The page component
 * calls it via a click handler that also writes to the clipboard and shows a toast; those two
 * are testable through e2e (Playwright), not here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildInstallPrompt } from '../client/src/utils/install-prompt.js';

// The approved wording, with the two placeholders the function fills in.
const EXPECTED = [
  '幫我安裝 OwnMind。',
  '先讀 <API_URL>/install-manual.md，照手冊的步驟做。',
  '依這台電腦的作業系統，從下面挑一行執行，只執行一次。畫面上顯示 NEXT 就照 NEXT 做；顯示 FIX 就先執行 FIX 那一行的指令，再重跑一次安裝指令；顯示 ASK 才來問我。',
  '安裝過程需要我按「允許」或開權限時，一步一步告訴我按哪裡。相依的軟體都由安裝指令自己處理，不要叫我手動裝。',
  '',
  'macOS:',
  'curl -fsSL <API_URL>/install.sh | bash -s -- <KEY> <API_URL>',
  '',
  'Windows (PowerShell):',
  "$env:OWNMIND_API_KEY='<KEY>'; $env:OWNMIND_API_URL='<API_URL>'; irm <API_URL>/install.ps1 | iex",
].join('\n');

const expectedFor = (key, url) => EXPECTED.split('<API_URL>').join(url).split('<KEY>').join(key);

describe('buildInstallPrompt', () => {
  it('returns exactly the approved text with the key and the server URL filled in', () => {
    const out = buildInstallPrompt({ api_key: 'sk-abc123' }, 'https://server.example/ownmind');
    assert.equal(out, expectedFor('sk-abc123', 'https://server.example/ownmind'));
  });

  it('points at the OwnMind server, never at raw.githubusercontent.com', () => {
    const out = buildInstallPrompt({ api_key: 'k' }, 'https://server.example/ownmind');
    assert.doesNotMatch(out, /raw\.githubusercontent\.com/);
    assert.match(out, /https:\/\/server\.example\/ownmind\/install-manual\.md/);
    assert.match(out, /https:\/\/server\.example\/ownmind\/install\.sh \| bash -s -- k https:\/\/server\.example\/ownmind/);
    assert.match(out, /irm https:\/\/server\.example\/ownmind\/install\.ps1 \| iex/);
  });

  it('strips a trailing slash from the URL so no address ends up with a double slash', () => {
    const out = buildInstallPrompt({ api_key: 'k' }, 'https://server.example/ownmind/');
    assert.equal(out, expectedFor('k', 'https://server.example/ownmind'));
    assert.doesNotMatch(out, /ownmind\/\//);
  });

  it('interpolates the user-specific api_key, does not leak another user', () => {
    const a = buildInstallPrompt({ api_key: 'sk-alice' }, 'https://x/ownmind');
    const b = buildInstallPrompt({ api_key: 'sk-bob' }, 'https://x/ownmind');
    assert.match(a, /sk-alice/);
    assert.doesNotMatch(a, /sk-bob/);
    assert.match(b, /sk-bob/);
    assert.doesNotMatch(b, /sk-alice/);
  });

  it('puts a key that contains replacement-pattern characters into the text unchanged', () => {
    const out = buildInstallPrompt({ api_key: 'a$&b$1c' }, 'https://x/ownmind');
    assert.equal(out, expectedFor('a$&b$1c', 'https://x/ownmind'));
  });

  it('rejects a missing api_key rather than emitting a broken command', () => {
    // A blank api_key in the command line would install nothing and leave no trail.
    assert.throws(() => buildInstallPrompt({ api_key: '' }, 'https://x'), /api_key/);
    assert.throws(() => buildInstallPrompt({}, 'https://x'), /api_key/);
  });

  it('rejects a missing api_url the same way', () => {
    assert.throws(() => buildInstallPrompt({ api_key: 'k' }, ''), /api_url/);
    assert.throws(() => buildInstallPrompt({ api_key: 'k' }), /api_url/);
  });
});
