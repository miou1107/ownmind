/**
 * hooks/lib/missing-skills.js — iron rules this machine cannot follow, because a skill the
 * rule tells the AI to use is not installed here (issue #139).
 *
 * The server sends, with the init payload, the skills each rule needs (`iron_rule_skills`,
 * see shared/required-skills.js). Which skills a machine has is only knowable on the machine,
 * so the comparison happens here, at every session start, against the folders Claude Code
 * loads skills from.
 *
 * Both session-start entry points call this module — ownmind-session-start.js on Windows and
 * session-start-output.js on macOS and Linux. A channel written into one of them is a channel
 * the other platform silently lacks; see hooks/lib/bug-report-notifications.js for the two
 * times that happened.
 *
 * What this does is tell people, once per session: the AI in the session context, and the
 * user through the hook's systemMessage. It does not block anything — a rule the machine cannot
 * satisfy would otherwise stop every edit. Being told is not the same as the rule being
 * followed; this makes the gap visible, it does not close it.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Plugins install into nested caches (`plugins/cache/<marketplace>/<plugin>/<version>/…`).
 * These bound the fallback walk so a large plugin folder cannot eat the hook's time budget.
 */
const PLUGIN_WALK_MAX_DEPTH = 7;
const PLUGIN_WALK_MAX_DIRS = 4000;

/**
 * Skills that come with Claude Code itself and so never appear in any folder. Without this a
 * rule saying "run `/code-review`" would be reported missing on every machine, every session.
 * Best effort: a newer built-in missing from here is reported missing to the user, and the AI
 * is still told to trust its own skill list (missingSkillContextLines).
 */
const BUILT_IN_SKILLS = new Set([
  'simplify', 'code-review', 'security-review', 'review', 'ultrareview', 'init', 'loop',
  'schedule', 'batch', 'debug', 'run', 'claude-api', 'update-config', 'keybindings-help',
  'fewer-permission-prompts', 'compact', 'clear', 'memory', 'pr-comments', 'statusline',
  'agents', 'hooks', 'mcp', 'model', 'config', 'doctor', 'help',
]);

/** Plugins a host app supplies without installing anything under ~/.claude. */
const HOST_PROVIDED_PLUGINS = new Set(['anthropic-skills']);

/**
 * Whether a directory entry is a folder (or a file), following links. `Dirent.isDirectory()`
 * is false for a symlink and for a Windows junction, and linking a skill in from a checkout
 * is a normal way to install one.
 */
function isKind(dir, entry, kind) {
  if (kind === 'dir' ? entry.isDirectory() : entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    const st = fs.statSync(path.join(dir, entry.name));
    return kind === 'dir' ? st.isDirectory() : st.isFile();
  } catch {
    return false;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** The `name:` a SKILL.md declares in its frontmatter, when it declares one. */
function frontmatterName(skillMd) {
  let head = '';
  try {
    head = fs.readFileSync(skillMd, 'utf8').slice(0, 2000);
  } catch {
    return null;
  }
  const fm = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const line = fm[1].match(/^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m);
  return line ? line[1].trim() : null;
}

/**
 * Add every skill found directly under `skillsDir` (`<skillsDir>/<name>/SKILL.md`), under its
 * folder name and under the name its frontmatter declares, prefixed with `prefix` when given.
 */
function addSkillsIn(skillsDir, into, prefix = '') {
  for (const entry of listDir(skillsDir)) {
    if (!isKind(skillsDir, entry, 'dir')) continue;
    const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;
    const names = [entry.name, frontmatterName(skillMd)].filter(Boolean);
    for (const n of names) {
      into.add(n);
      if (prefix) into.add(`${prefix}:${n}`);
    }
  }
}

/** Slash commands are skills too: `<commandsDir>/<name>.md`. */
function addCommandsIn(commandsDir, into, prefix = '') {
  for (const entry of listDir(commandsDir)) {
    if (!isKind(commandsDir, entry, 'file') || !entry.name.endsWith('.md')) continue;
    const n = entry.name.slice(0, -3);
    into.add(n);
    if (prefix) into.add(`${prefix}:${n}`);
  }
}

/** The plugin a folder belongs to, from the nearest `.claude-plugin/plugin.json`. */
function pluginNameAt(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8'));
    return typeof manifest.name === 'string' && manifest.name ? manifest.name : '';
  } catch {
    return '';
  }
}

/**
 * Installed plugins, from Claude Code's own record of them.
 *
 * `plugins/` also holds every marketplace's whole catalog (`plugins/marketplaces/…`), so a
 * folder with a plugin manifest in it is not evidence of an installed plugin. The record lists
 * each installed plugin under `"<name>@<marketplace>"` with its `installPath`; its shape has
 * changed between versions (one entry per plugin, then a list per plugin), and both are read.
 *
 * @returns {boolean} whether the record was there to read
 */
function addInstalledPlugins(pluginsDir, into) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'installed_plugins.json'), 'utf8'));
  } catch {
    return false;
  }
  const plugins = record && typeof record.plugins === 'object' && record.plugins ? record.plugins : {};
  for (const [key, value] of Object.entries(plugins)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      const dir = entry && typeof entry.installPath === 'string' ? entry.installPath : '';
      if (!dir) continue;
      const name = pluginNameAt(dir) || String(key).split('@')[0];
      addSkillsIn(path.join(dir, 'skills'), into, name);
      addCommandsIn(path.join(dir, 'commands'), into, name);
    }
  }
  return true;
}

/**
 * Fallback when the record is missing: every plugin root under `plugins/cache`, which holds
 * installed plugins only — never the marketplace catalogs.
 */
function addPluginSkills(pluginsDir, into) {
  if (addInstalledPlugins(pluginsDir, into)) return;
  const queue = [[path.join(pluginsDir, 'cache'), 0]];
  let visited = 0;
  while (queue.length && visited < PLUGIN_WALK_MAX_DIRS) {
    const [dir, depth] = queue.shift();
    visited += 1;
    const plugin = pluginNameAt(dir);
    if (plugin) {
      addSkillsIn(path.join(dir, 'skills'), into, plugin);
      addCommandsIn(path.join(dir, 'commands'), into, plugin);
      continue;
    }
    if (depth >= PLUGIN_WALK_MAX_DEPTH) continue;
    for (const entry of listDir(dir)) {
      if (isKind(dir, entry, 'dir') && !entry.name.startsWith('.')) {
        queue.push([path.join(dir, entry.name), depth + 1]);
      }
    }
  }
}

/**
 * The skill names Claude Code can load on this machine, as far as its folders show.
 *
 * Covers the personal folder (and one level of grouping inside it, which is how some sync
 * tools lay skills out), the project's own folder, personal slash commands, and installed
 * plugins. A skill the host provides from somewhere else — built into an app, say — is not
 * visible here; the session context tells the AI to trust its own skill list over this one.
 *
 * @param {object} opts
 * @param {string} opts.home
 * @param {string} [opts.projectDir]
 * @param {string} [opts.claudeConfigDir] CLAUDE_CONFIG_DIR, when set
 * @returns {Set<string>}
 */
export function listInstalledSkills({ home, projectDir, claudeConfigDir }) {
  const installed = new Set();
  const claudeDir = claudeConfigDir || path.join(home, '.claude');

  const personal = path.join(claudeDir, 'skills');
  addSkillsIn(personal, installed);
  for (const entry of listDir(personal)) {
    if (isKind(personal, entry, 'dir')) addSkillsIn(path.join(personal, entry.name), installed);
  }
  addCommandsIn(path.join(claudeDir, 'commands'), installed);

  if (projectDir) {
    addSkillsIn(path.join(projectDir, '.claude', 'skills'), installed);
    addCommandsIn(path.join(projectDir, '.claude', 'commands'), installed);
  }

  addPluginSkills(path.join(claudeDir, 'plugins'), installed);
  return installed;
}

/**
 * Whether `name` is available. A plugin-prefixed name is also satisfied by the bare skill name,
 * since a plugin whose manifest could not be read is still a plugin whose skills load.
 */
function isInstalled(name, installed) {
  if (installed.has(name) || BUILT_IN_SKILLS.has(name)) return true;
  const colon = name.indexOf(':');
  if (colon === -1) return false;
  return HOST_PROVIDED_PLUGINS.has(name.slice(0, colon)) || installed.has(name.slice(colon + 1));
}

/**
 * The rules with at least one skill this machine lacks, and which skills those are.
 *
 * @param {unknown} ironRuleSkills the init payload's `iron_rule_skills`
 * @param {Set<string>} installed
 * @returns {{ code: string, title: string, missing: string[] }[]}
 */
export function findMissingSkills(ironRuleSkills, installed) {
  if (!Array.isArray(ironRuleSkills)) return [];
  const out = [];
  for (const rule of ironRuleSkills) {
    if (!rule || !Array.isArray(rule.skills)) continue;
    const missing = rule.skills.filter((s) => typeof s === 'string' && s && !isInstalled(s, installed));
    if (missing.length) {
      out.push({ code: String(rule.code || 'IR-?'), title: String(rule.title || ''), missing });
    }
  }
  return out;
}

/**
 * Everything one entry point needs, from the init payload. Never throws: a session start
 * must not be lost to this check.
 *
 * @param {object} initData
 * @param {object} opts see listInstalledSkills
 * @returns {{ code: string, title: string, missing: string[] }[]}
 */
export function missingSkillsFor(initData, opts) {
  try {
    const wanted = initData?.iron_rule_skills;
    if (!Array.isArray(wanted) || wanted.length === 0) return [];
    return findMissingSkills(wanted, listInstalledSkills(opts));
  } catch {
    return [];
  }
}

/**
 * The session-context section, for the AI. Model-facing, so English by policy.
 *
 * @param {{ code: string, title: string, missing: string[] }[]} missing
 * @returns {string[]} lines, or [] when nothing is missing
 */
export function missingSkillContextLines(missing) {
  if (!Array.isArray(missing) || missing.length === 0) return [];
  return [
    '## Iron rules this machine cannot follow as written',
    'Each rule below tells you to use a skill that OwnMind did not find in this machine\'s skill folders:',
    ...missing.map((r) => `- ${r.code}: ${r.title} — needs ${r.missing.map((s) => `\`${s}\``).join(', ')}`),
    'If a skill named here is in your own list of available skills, it is installed some other '
      + 'way: follow the rule as usual. Otherwise do not claim to have followed the rule, and do '
      + 'not quietly substitute something else for the skill. Tell the user it cannot be '
      + 'followed on this machine until the skill is installed, and when you report compliance '
      + 'for it, say in the context that the skill was missing.',
    '',
  ];
}

/**
 * The one line shown to the user. Built by the caller's `t` so the wording lives in
 * hooks/locales, where every user-facing hook sentence lives.
 *
 * @param {{ code: string, missing: string[] }[]} missing
 * @param {(key: string, params: object) => string} t
 * @returns {string|null}
 */
export function missingSkillNotice(missing, t) {
  if (!Array.isArray(missing) || missing.length === 0) return null;
  const list = missing.map((r) => `${r.code} (${r.missing.join(', ')})`).join('; ');
  return t('session.missingSkills', { count: missing.length, list });
}
