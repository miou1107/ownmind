/**
 * v1.26.49 — buildInstallPrompt() emits the same install string the legacy
 * /admin/ users tab emits at legacy/admin-v1.26/index.html:1474-1480.
 *
 * See openspec/changes/archive/v1.26.49-team-management-page/spec.md Requirement 5.
 *
 * Extracted to a pure function so this test doesn't need a React renderer. The
 * page component calls it via a click handler that also writes to the clipboard
 * and shows a toast; those two are testable through e2e (Playwright), not here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildInstallPrompt } from '../client/src/utils/install-prompt.js';

describe('buildInstallPrompt — legacy parity', () => {
  it('emits the same shape as legacy/admin-v1.26/index.html updatePrompt()', () => {
    const out = buildInstallPrompt({ api_key: 'sk-abc123' }, 'https://kkvin.com/ownmind');

    assert.ok(out.startsWith('幫我安裝 OwnMind：'), 'must open with the same header the legacy tab uses');
    assert.match(out, /macOS \/ Linux:/);
    assert.match(out, /Windows \(PowerShell\):/);
    assert.match(
      out,
      /curl -sL https:\/\/raw\.githubusercontent\.com\/miou1107\/ownmind\/main\/install\.sh \| bash -s -- sk-abc123 https:\/\/kkvin\.com\/ownmind/,
      'unix branch: install.sh curl piped to bash with api_key and api_url',
    );
    assert.match(
      out,
      /\$env:OWNMIND_API_KEY='sk-abc123'; \$env:OWNMIND_API_URL='https:\/\/kkvin\.com\/ownmind'; irm https:\/\/raw\.githubusercontent\.com\/miou1107\/ownmind\/main\/install\.ps1 \| iex/,
      'windows branch: env vars + irm | iex',
    );
  });

  it('interpolates the user-specific api_key, does not leak another user', () => {
    const a = buildInstallPrompt({ api_key: 'sk-alice' }, 'https://x/ownmind');
    const b = buildInstallPrompt({ api_key: 'sk-bob' }, 'https://x/ownmind');
    assert.match(a, /sk-alice/);
    assert.doesNotMatch(a, /sk-bob/);
    assert.match(b, /sk-bob/);
    assert.doesNotMatch(b, /sk-alice/);
  });

  it('interpolates api_url verbatim, without escaping or trailing slash', () => {
    const out = buildInstallPrompt({ api_key: 'k' }, 'https://foo.example/ownmind');
    assert.match(out, /https:\/\/foo\.example\/ownmind/);
    assert.doesNotMatch(out, /https:\/\/foo\.example\/ownmind\//);
  });

  it('rejects a missing api_key rather than emitting a broken command', () => {
    // A blank api_key in the command line would install nothing and leave no trail.
    // Better to throw at compose time than to hand the admin a copy-paste that
    // fails silently on the target machine.
    assert.throws(() => buildInstallPrompt({ api_key: '' }, 'https://x'), /api_key/);
    assert.throws(() => buildInstallPrompt({}, 'https://x'), /api_key/);
  });

  it('rejects a missing api_url the same way', () => {
    assert.throws(() => buildInstallPrompt({ api_key: 'k' }, ''), /api_url/);
    assert.throws(() => buildInstallPrompt({ api_key: 'k' }), /api_url/);
  });
});
