import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The install section of skills/ownmind-upgrade.md is the runbook the colleague's AI follows
 * (zero-touch-install). The installer's output only works if the AI reads it the way the
 * installer meant: which line wins, what an ERROR with nothing after it means, where the
 * verification conversation takes its title from, and that the test memory it saves is removed.
 */

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const skill = fs.readFileSync(path.join(repoRoot, 'skills', 'ownmind-upgrade.md'), 'utf8');
const start = skill.indexOf('\nAudience: the AI that runs the OwnMind installer');
const section = skill.slice(start, skill.indexOf('\n## ', start + 1));

describe('the install section of skills/ownmind-upgrade.md', () => {
  it('exists, and is self-contained enough to be lifted into the install manual', () => {
    assert.ok(start > 0 && section.length > 1000);
  });

  it('says which line wins and what to do with an ERROR that has nothing after it', () => {
    assert.match(section, /ASK:` line appeared anywhere in the run, the ASK wins/);
    assert.match(section, /nearest earlier `FIX:` or `ASK:`/);
    assert.match(section, /say the text of the `ERROR:` line to the user in plain words and stop/);
  });

  it('takes the verification title from the NEXT line, with no node call on the colleague machine', () => {
    assert.match(section, /NEXT:verify:new-session:<title>/);
    assert.doesNotMatch(section, /install-messages\.cjs/);
  });

  it('does not ask the new session to look at the input bar, which only the user can see', () => {
    assert.doesNotMatch(section, /status button/);
  });

  it('removes the test memory it saves, and says so in its report', () => {
    assert.match(section, /ownmind_disable.{0,40}install check/);
    assert.match(section, /test memory was removed/);
  });

  it('tells the AI to point at the card when the session does not start by itself', () => {
    assert.match(section, /click the card/);
  });

  it('lists the four ASK codes, and the older error table says it is for git upgrades only', () => {
    for (const code of ['no_network', 'node_download', 'disk_full', 'unsupported_os']) assert.ok(section.includes(code), code);
    assert.match(skill, /這張表只適用於 git 安裝的升級與修復/);
  });
});
