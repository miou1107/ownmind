import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * docs/ai-install-runbook.md is the manual the colleague's AI reads before it runs the
 * installer (served as /install-manual.md). skills/ownmind-upgrade.md carries the same rules
 * for an AI that cannot reach the server. These tests keep the two from drifting and keep the
 * manual's code list equal to what the scripts really print.
 */

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const manual = read('docs/ai-install-runbook.md');
const skill = read('skills/ownmind-upgrade.md');

const SCRIPTS = [
  'scripts/bootstrap.sh',
  'scripts/bootstrap.ps1',
  'install.sh',
  'install.ps1',
  'scripts/install-helpers/fetch-release.sh',
  'scripts/install-helpers/fetch-release.ps1',
  'scripts/install-helpers/ensure-node-runtime.sh',
  'scripts/install-helpers/ensure-node-runtime.ps1',
];

function codesIn(text, prefix) {
  return new Set([...text.matchAll(new RegExp(`\\b${prefix}:([a-z][a-z_]*):`, 'g'))].map((m) => m[1]));
}

function emittedCodes(prefix) {
  const found = new Set();
  for (const file of SCRIPTS) for (const c of codesIn(read(file), prefix)) found.add(c);
  return found;
}

function documentedCodes(prefix) {
  return new Set([...manual.matchAll(new RegExp(`\`${prefix}:([a-z][a-z_]*)\``, 'g'))].map((m) => m[1]));
}

function between(text, startMarker, endMarker) {
  const a = text.indexOf(startMarker);
  assert.ok(a >= 0, `missing ${startMarker}`);
  const b = text.indexOf(endMarker, a + startMarker.length);
  // The last section of the manual has no heading after it, and the last list of a section no blank line.
  if (b < 0 && (endMarker === '\n## ' || endMarker === '\n\n')) return text.slice(a + startMarker.length);
  assert.ok(b > a, `missing ${endMarker}`);
  return text.slice(a + startMarker.length, b);
}

function sentences(block) {
  return block
    .split('\n')
    .map((l) => l.replace(/^\s*(?:\d+\.|[-*])\s+/, '').trim())
    .filter(Boolean);
}

describe('docs/ai-install-runbook.md', () => {
  it('starts with the audience line, so a human opening it knows it is not written for them', () => {
    assert.equal(manual.split('\n')[0], 'audience: agent');
  });

  it('has the five sections', () => {
    const headings = [...manual.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    assert.equal(headings.length, 5, headings.join(' | '));
    assert.match(headings[0], /What gets installed/);
    assert.match(headings[1], /command and the output/i);
    assert.match(headings[2], /Troubleshooting/);
    assert.match(headings[3], /Definition of done/);
    assert.match(headings[4], /verification/i);
  });

  it('documents every FIX: code the scripts print, and no code the scripts do not print', () => {
    const emitted = emittedCodes('FIX');
    assert.ok(emitted.size >= 4, `expected the scripts to print at least four FIX codes, found ${[...emitted]}`);
    assert.deepEqual([...documentedCodes('FIX')].sort(), [...emitted].sort());
  });

  it('documents every ASK: code the scripts print, and no code the scripts do not print', () => {
    const emitted = emittedCodes('ASK');
    assert.ok(emitted.size >= 4, `expected the scripts to print at least four ASK codes, found ${[...emitted]}`);
    assert.deepEqual([...documentedCodes('ASK')].sort(), [...emitted].sort());
  });

  it('names every prefix the scripts print', () => {
    for (const p of ['INFO', 'OK', 'ERROR', 'FIX', 'ASK', 'NEXT']) assert.ok(manual.includes(`\`${p}:`), p);
  });

  it('has a Permissions subsection that names each permission the install can hit', () => {
    const perms = between(manual, '### Permissions', '\n## ');
    assert.match(perms, /Allow/, 'the AI tool\'s allow prompt');
    assert.match(perms, /Shift\+Tab/, 'the Claude Code CLI mode switch');
    assert.match(perms, /permission-mode selector|permission mode/i, 'the desktop app mode selector');
    assert.match(perms, /read-only|plan mode/i, 'a mode that forbids commands');
    assert.match(perms, /PowerShell/);
    assert.match(perms, /execution policy/i);
    assert.match(perms, /irm \| iex/);
    assert.match(perms, /macOS/);
    assert.match(perms, /folder/i);
    assert.match(perms, /not an administrator|non-admin/i);
    assert.match(perms, /administrator/i);
  });

  it('lists the four things the AI must never suggest', () => {
    const perms = between(manual, '### Permissions', '\n## ');
    const list = between(perms, 'Never suggest', '\n\n');
    for (const word of ['git', 'Node.js', 'Homebrew', 'winget']) assert.ok(list.includes(word), word);
  });

  it('does not claim the AI already has a skill the install is about to put there, and limits removal to when asked', () => {
    assert.doesNotMatch(manual, /your skill/i);
    assert.match(manual, /the `ownmind-upgrade` skill carries once OwnMind is installed/);
    assert.match(manual, /applies only when the colleague asks to remove OwnMind/);
  });

  it('never tells the user to install a prerequisite by hand', () => {
    assert.doesNotMatch(manual, /brew install/);
    assert.doesNotMatch(manual, /xcode-select/);
    assert.doesNotMatch(manual, /winget install/);
    assert.doesNotMatch(manual, /nodejs\.org\/(en\/)?download/);
  });

  it('says what finished looks like: the files, the summary line, the next conversation', () => {
    const done = between(manual, '## Definition of done', '\n## ');
    assert.match(done, /\.release/);
    assert.match(done, /mcp\/node_modules/);
    assert.match(done, /settings\.json/);
    assert.match(done, /\.claude\.json/);
    assert.match(done, /Summary:\s+N passed, N warnings, N failed/);
    assert.match(done, /next conversation/i);
    assert.match(done, /error stream/i, 'the summary line may be on stderr');
  });

  it('runs the same verification as the skill: save, find, remove, one line per item', () => {
    const v = between(manual, '## The verification the new session runs', '\n## ');
    assert.match(v, /ownmind_search/);
    assert.match(v, /OwnMind install check/);
    assert.match(v, /ownmind_disable/);
    assert.match(v, /test memory was removed/);
  });
});

describe('the manual reaches production', () => {
  it('the Dockerfile copies it, and .dockerignore re-includes it', () => {
    assert.match(read('Dockerfile'), /^COPY docs\/ai-install-runbook\.md docs\/ai-install-runbook\.md$/m);
    assert.match(read('.dockerignore'), /^!docs\/ai-install-runbook\.md$/m);
  });
});

describe('manual and skill carry the same rules', () => {
  const START = '<!-- rules:start -->';

  for (const [name, minLines] of [['rules', 15], ['verify', 8]]) {
    it(`the ${name} block is the same text in both, sentence for sentence`, () => {
      const inManual = sentences(between(manual, `<!-- ${name}:start -->`, `<!-- ${name}:end -->`));
      const inSkill = sentences(between(skill, `<!-- ${name}:start -->`, `<!-- ${name}:end -->`));
      assert.ok(inManual.length >= minLines, `the ${name} block should not be trivial`);
      assert.deepEqual(inSkill, inManual);
    });
  }

  it('the skill points at the manual first and keeps the rules for when it cannot be reached', () => {
    const section = skill.slice(skill.indexOf('## 安裝 OwnMind'));
    assert.match(section, /<API_URL>\/install-manual\.md/);
    assert.match(section, /unreachable/i);
    assert.ok(section.indexOf('install-manual.md') < section.indexOf(START));
  });

  it('the skill mentions every FIX and ASK code the scripts print', () => {
    for (const c of emittedCodes('FIX')) assert.ok(skill.includes(`\`${c}\``), `skill is missing FIX ${c}`);
    for (const c of emittedCodes('ASK')) assert.ok(skill.includes(c), `skill is missing ASK ${c}`);
  });
});
