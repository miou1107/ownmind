// The Windows locale-copy twins must skip dot-prefixed files, like their bash counterparts do
// for free (gate-message-i18n task 7 follow-up).
//
// install.sh copies the hook dictionaries with `cp "$OWNMIND_DIR/hooks/locales/"*.json`. A
// POSIX shell glob never matches a leading dot, so `.translate-cache.json` — the translate
// pipeline's per-key hash cache, gitignored, regenerated locally, never a dictionary — is
// silently skipped. PowerShell's wildcards have no such rule: "*.json" matches
// ".translate-cache.json" (the `*` happily eats the leading dot), so the three ps1 twins
// deployed a build artifact into ~\.claude\hooks\locales that no bash machine has ever had.
// Harmless at runtime — hooks/lib/i18n.js loads dictionaries by name, not by directory scan —
// but this repo enforces sh/ps1 parity precisely so "harmless" divergences do not accumulate,
// and check-sync.ps1 would have reported permanent drift the moment the other two stopped
// copying it.
//
// This is a static source check, not an execution: no PowerShell interpreter exists on the
// machines that run this suite (`pwsh` and `powershell` are both absent on the dev macOS
// host and on CI), so the only mechanical guard available is that the exclusion is still
// written down. It cannot prove PowerShell honours it; it can prove nobody deleted it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(relPath) {
  return readFileSync(join(repoRoot, relPath), 'utf8');
}

// Each entry: the script, the line that copies/compares the locale dictionaries, and the
// dot-name exclusion that must sit on it. The exclusion form differs by call shape —
// Copy-Item takes a wildcard path so -Exclude applies to the resolved contents, while the
// Get-ChildItem pipelines filter the enumerated names — but the wildcard literal '.*' is
// the same in all three so the parity is legible at a glance.
const SITES = [
  {
    file: 'install.ps1',
    copyLine: /Copy-Item \(Join-Path \$HookLocalesSrc "\*\.json"\)[^\r\n]*/,
    exclusion: /-Exclude "\.\*"/,
  },
  {
    file: 'scripts/update.ps1',
    copyLine: /Get-ChildItem -Path \$LocalesSrc -Filter "\*\.json"[\s\S]{0,200}?ForEach-Object/,
    exclusion: /Where-Object \{ \$_\.Name -notlike "\.\*" \}/,
  },
  {
    file: 'scripts/check-sync.ps1',
    copyLine: /Get-ChildItem -Path \$localesDir -Filter '\*\.json'[\s\S]{0,200}?ForEach-Object/,
    exclusion: /Where-Object \{ \$_\.Name -notlike '\.\*' \}/,
  },
];

describe('hooks/locales deployment — ps1 twins skip dot-prefixed files like the sh side does', () => {
  it('install.sh still relies on a POSIX glob (the behaviour the ps1 side is matching)', () => {
    const sh = read('install.sh');
    assert.match(
      sh,
      /cp "\$OWNMIND_DIR\/hooks\/locales\/"\*\.json/,
      'install.sh no longer copies hooks/locales with a bare *.json glob — the ps1 exclusions '
        + 'below were justified by that glob\'s dotfile behaviour, so re-derive them if the '
        + 'bash side changed shape'
    );
  });

  for (const site of SITES) {
    it(`${site.file} excludes dot-prefixed names when shipping hooks/locales`, () => {
      const content = read(site.file);
      const block = content.match(site.copyLine);
      assert.ok(
        block,
        `${site.file} no longer contains the hooks/locales copy this test was written against `
          + '— the assertion is dead, re-point it at the new call site'
      );
      assert.match(
        block[0],
        site.exclusion,
        `${site.file}'s hooks/locales copy lost its dot-name exclusion, so PowerShell's *.json `
          + 'will match .translate-cache.json again and deploy a gitignored build artifact that '
          + `no bash machine has (got: ${JSON.stringify(block[0])})`
      );
    });
  }

  it('.translate-cache.json is in fact a gitignored artifact, not a shipped dictionary', () => {
    assert.match(
      read('.gitignore'),
      /^hooks\/locales\/\.translate-cache\.json$/m,
      'the exclusions above exist because .translate-cache.json is a local build artifact — if '
        + 'it became a tracked, shipped file, they are wrong rather than merely stale'
    );
  });
});
