/**
 * Issue #139 — a rule named a skill this machine did not have, and nothing said so.
 *
 * The rule was delivered, shown at session start and again before every edit, and could not
 * be followed: `~/.claude/skills/` held neither skill it named. The only reason anyone found
 * out is that the AI happened to list the folder.
 *
 * What is pinned here: the machine works out which named skills it lacks, and at session start
 * tells the AI (in the context) and the user (in the hook's systemMessage) — on both platform
 * entry points, through one module.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';
import { stageHookHome } from './helpers/hook-home.js';
import { startServer } from './helpers/app-server.js';
import {
  listInstalledSkills, findMissingSkills, missingSkillsFor, missingSkillContextLines, missingSkillNotice,
} from '../hooks/lib/missing-skills.js';
import { renderSessionContext } from '../hooks/lib/render-session-context.js';
import { t, resetI18nCacheForTests } from '../hooks/lib/i18n.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function writeSkill(dir, name, frontmatterName) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  const fm = frontmatterName ? `---\nname: ${frontmatterName}\ndescription: x\n---\n` : '';
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `${fm}# ${name}\n`);
}

/** A home laid out the way Claude Code keeps skills, with one of everything. */
function stageSkillHome() {
  const home = tempDir('missing-skills-home-');
  const skills = path.join(home, '.claude', 'skills');
  writeSkill(skills, 'humanizer-tw');
  writeSkill(skills, 'folder-name', 'declared-name');
  writeSkill(path.join(skills, 'synced'), 'grouped-skill');
  fs.mkdirSync(path.join(skills, 'not-a-skill'), { recursive: true }); // no SKILL.md

  fs.mkdirSync(path.join(home, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'commands', 'my-command.md'), '# cmd\n');

  const plugin = path.join(home, '.claude', 'plugins', 'cache', 'market', 'superpowers', '1.2.3');
  fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'superpowers' }));
  writeSkill(path.join(plugin, 'skills'), 'brainstorming');

  // A marketplace catalog: plugins listed for installing, none of them installed.
  const catalog = path.join(home, '.claude', 'plugins', 'marketplaces', 'market', 'plugins', 'catalog-only');
  fs.mkdirSync(path.join(catalog, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(catalog, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'catalog-only' }));
  writeSkill(path.join(catalog, 'skills'), 'catalog-skill');

  // A skill linked in from elsewhere, the way one is installed from a checkout. A junction,
  // because that is what Windows lets an ordinary user create.
  const checkout = tempDir('missing-skills-checkout-');
  writeSkill(checkout, 'linked-skill');
  fs.symlinkSync(path.join(checkout, 'linked-skill'), path.join(skills, 'linked-skill'), 'junction');

  const project = tempDir('missing-skills-project-');
  writeSkill(path.join(project, '.claude', 'skills'), 'project-skill');
  return { home, project };
}

const REPORTED = [{ code: 'IR-007', title: '寫中文前後要過兩道工具', skills: ['zh-tw-doc-copy', 'humanizer-tw'] }];

describe('what this machine has', () => {
  const { home, project } = stageSkillHome();
  const installed = listInstalledSkills({ home, projectDir: project });

  it('personal skills, by folder name and by the name their SKILL.md declares', () => {
    for (const n of ['humanizer-tw', 'folder-name', 'declared-name']) assert.ok(installed.has(n), n);
  });

  it('a skill kept one folder down, the way sync tools group them', () => {
    assert.ok(installed.has('grouped-skill'));
  });

  it('a folder with no SKILL.md is not a skill', () => {
    assert.ok(!installed.has('not-a-skill'));
  });

  it('personal slash commands, project skills and plugin skills (bare and prefixed)', () => {
    for (const n of ['my-command', 'project-skill', 'brainstorming', 'superpowers:brainstorming']) {
      assert.ok(installed.has(n), n);
    }
  });

  it('a skill folder that is a link is followed', () => {
    assert.ok(installed.has('linked-skill'));
  });

  it('a plugin that is only in a marketplace catalog is not installed', () => {
    assert.ok(!installed.has('catalog-skill'));
    assert.ok(!installed.has('catalog-only:catalog-skill'));
  });

  it('Claude Code\'s own record of installed plugins is what counts, in either shape', () => {
    for (const shape of ['list', 'single']) {
      const h = tempDir('missing-skills-record-');
      const pluginsDir = path.join(h, '.claude', 'plugins');
      const installedAt = path.join(h, 'somewhere', 'recorded');
      writeSkill(path.join(installedAt, 'skills'), 'recorded-skill');
      // Also in cache, but not in the record: the record wins, so this one does not count.
      const cached = path.join(pluginsDir, 'cache', 'm', 'stale', '0.1');
      fs.mkdirSync(path.join(cached, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(path.join(cached, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'stale' }));
      writeSkill(path.join(cached, 'skills'), 'stale-skill');
      const entry = { installPath: installedAt, version: '1.0.0' };
      fs.writeFileSync(path.join(pluginsDir, 'installed_plugins.json'), JSON.stringify({
        version: 2, plugins: { 'recorded@market': shape === 'list' ? [entry] : entry },
      }));
      const found = listInstalledSkills({ home: h });
      assert.ok(found.has('recorded:recorded-skill'), shape);
      assert.ok(!found.has('stale-skill'), shape);
    }
  });

  it('CLAUDE_CONFIG_DIR moves where personal skills are looked for', () => {
    const elsewhere = tempDir('missing-skills-config-');
    writeSkill(path.join(elsewhere, 'skills'), 'moved-skill');
    const found = listInstalledSkills({ home, claudeConfigDir: elsewhere });
    assert.ok(found.has('moved-skill'));
    assert.ok(!found.has('humanizer-tw'), 'the default folder is not read when the config dir is moved');
  });

  it('a home with no .claude folder at all has nothing, and does not throw', () => {
    assert.equal(listInstalledSkills({ home: tempDir('missing-skills-empty-') }).size, 0);
  });
});

describe('which rules come up short', () => {
  it('the reported case: one of the two skills is missing, and it is the one named', () => {
    const missing = findMissingSkills(REPORTED, new Set(['humanizer-tw']));
    assert.deepEqual(missing, [{ code: 'IR-007', title: '寫中文前後要過兩道工具', missing: ['zh-tw-doc-copy'] }]);
  });

  it('a rule whose skills are all here is not mentioned', () => {
    assert.deepEqual(findMissingSkills(REPORTED, new Set(['humanizer-tw', 'zh-tw-doc-copy'])), []);
  });

  it('a plugin-prefixed need is met by the bare skill', () => {
    const rules = [{ code: 'IR-1', title: 't', skills: ['superpowers:brainstorming'] }];
    assert.deepEqual(findMissingSkills(rules, new Set(['brainstorming'])), []);
  });

  it('skills that come with Claude Code or the host app are never reported', () => {
    // They are never on disk. Reporting them would put a warning in front of the user at
    // every session start for a rule that is being followed.
    const rules = [{ code: 'IR-1', title: 't', skills: ['code-review', 'simplify', 'anthropic-skills:docx'] }];
    assert.deepEqual(findMissingSkills(rules, new Set()), []);
  });

  it('an older server that sends no list means no check, not an error', () => {
    assert.deepEqual(findMissingSkills(undefined, new Set()), []);
    assert.deepEqual(missingSkillsFor({}, { home: tempDir('missing-skills-noop-') }), []);
  });
});

describe('what the AI is told', () => {
  it('names the rule and the missing skill, and says not to claim or substitute', () => {
    const text = missingSkillContextLines([{ code: 'IR-007', title: 'T', missing: ['zh-tw-doc-copy'] }]).join('\n');
    assert.match(text, /IR-007: T — needs `zh-tw-doc-copy`/);
    assert.match(text, /do not claim to have followed the rule/);
    assert.match(text, /quietly substitute/);
    // A skill the host provides from outside these folders must not be reported as missing.
    assert.match(text, /in your own list of available skills/);
  });

  it('nothing missing, nothing said', () => {
    assert.deepEqual(missingSkillContextLines([]), []);
  });

  it('sits straight after the iron rules it qualifies', () => {
    const out = renderSessionContext({
      server_version: '1.30.28', iron_rules_digest: 'IR-007: T', team_standards_digest: '[團隊] S',
    }, [], { tip: () => 'tip', missingSkills: [{ code: 'IR-007', title: 'T', missing: ['a-b'] }] });
    const rules = out.indexOf('## Iron rules');
    const section = out.indexOf('## Iron rules this machine cannot follow');
    const team = out.indexOf('## Team standards');
    assert.ok(rules > -1 && rules < section && section < team, out);
  });
});

describe('what the user is told', () => {
  const ORIGINAL = process.env.OWNMIND_LOCALE_FORCE;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.OWNMIND_LOCALE_FORCE;
    else process.env.OWNMIND_LOCALE_FORCE = ORIGINAL;
    resetI18nCacheForTests();
  });
  const missing = [{ code: 'IR-007', title: 'T', missing: ['zh-tw-doc-copy', 'x-y'] }];

  for (const [locale, words] of [
    ['zh', /1 條規矩.*技能/],
    ['en', /cannot follow 1 of your rules.*skill/],
    ['ja', /1 件.*スキル/],
  ]) {
    it(`in ${locale}: how many rules, which skills, and what to do`, () => {
      process.env.OWNMIND_LOCALE_FORCE = locale;
      resetI18nCacheForTests();
      const line = missingSkillNotice(missing, t);
      assert.match(line, /^\[OwnMind\] 🟡 /);
      assert.match(line, words);
      assert.match(line, /IR-007 \(zh-tw-doc-copy, x-y\)/);
      assert.doesNotMatch(line, /\{(count|list)\}/, 'a placeholder was left unfilled');
    });
  }

  it('nothing missing, no line', () => {
    assert.equal(missingSkillNotice([], t), null);
  });
});

/** Run a hook script with this home and read its JSON. */
function hookEnv(home, project) {
  return {
    ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: project,
    CLAUDE_CONFIG_DIR: '', OWNMIND_LOCALE_FORCE: 'en',
  };
}

describe('the macOS and Linux entry point says it', () => {
  const run = (home, project, init) => JSON.parse(execFileSync('node', [
    path.join(repoRoot, 'hooks', 'lib', 'session-start-output.js'),
    JSON.stringify(init), '[]', '{}',
  ], { encoding: 'utf8', env: hookEnv(home, project) }));

  it('a missing skill reaches both the AI and the user', () => {
    const { home, project } = stageSkillHome();
    const out = run(home, project, { server_version: '1.30.28', iron_rules_digest: 'IR-007: T', iron_rule_skills: REPORTED });
    assert.match(out.hookSpecificOutput.additionalContext, /needs `zh-tw-doc-copy`/);
    assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /`humanizer-tw`/, 'an installed skill was reported missing');
    assert.match(out.systemMessage, /IR-007 \(zh-tw-doc-copy\)/);
  });

  it('everything installed: no section and no message', () => {
    const { home, project } = stageSkillHome();
    writeSkill(path.join(home, '.claude', 'skills'), 'zh-tw-doc-copy');
    const out = run(home, project, { server_version: '1.30.28', iron_rule_skills: REPORTED });
    assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /cannot follow as written/);
    assert.equal(out.systemMessage, undefined);
  });
});

describe('the Windows entry point says it too', () => {
  it('ownmind-session-start.js, against a server that sends the list', async () => {
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/api/memory/init')) {
        return res.end(JSON.stringify({
          server_version: '9.9.9-test', profile: { role: 'member' }, principles: [],
          iron_rules_digest: 'IR-007: T', iron_rule_skills: REPORTED, memories: [],
        }));
      }
      return res.end(req.url.includes('broadcast') ? '[]' : '{}');
    });
    const started = await startServer(server);
    const home = stageHookHome({ apiUrl: started.url, apiKey: 'test-key-0123456789abcdef' });
    writeSkill(path.join(home, '.claude', 'skills'), 'humanizer-tw');
    const project = tempDir('missing-skills-win-project-');

    try {
      const stdout = await new Promise((resolve, reject) => {
        const child = execFile('node', [path.join(repoRoot, 'hooks', 'ownmind-session-start.js')], {
          env: {
            ...hookEnv(home, project),
            OWNMIND_API_KEY: 'test-key-0123456789abcdef', OWNMIND_API_URL: started.url,
          },
          timeout: 20000,
        }, (err, out, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(out)));
        child.stdin.end(JSON.stringify({ session_id: 'win-skills', hook_event_name: 'SessionStart' }));
      });

      const out = JSON.parse(stdout);
      assert.match(out.hookSpecificOutput.additionalContext, /IR-007: 寫中文前後要過兩道工具 — needs `zh-tw-doc-copy`/);
      assert.match(out.systemMessage, /IR-007 \(zh-tw-doc-copy\)/);
    } finally {
      await started.close();
    }
  });
});

describe('both entry points go through the one module', () => {
  it('each computes the list and hands it to the renderer and to the user', () => {
    // A check written into one platform's entry point is a check the other silently lacks —
    // the bug-report channel went missing on macOS exactly that way.
    for (const rel of [path.join('hooks', 'ownmind-session-start.js'), path.join('hooks', 'lib', 'session-start-output.js')]) {
      const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      assert.match(src, /missingSkillsFor\(initData,/, `${rel} never works out what is missing`);
      assert.match(src, /missingSkills \}\)/, `${rel} never hands the result to the renderer`);
      assert.match(src, /systemMessage && \{ systemMessage \}/, `${rel} never tells the user`);
    }
  });
});
