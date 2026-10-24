'use strict';

/**
 * The artifacts an install is only complete once it has produced.
 *
 * Why this exists (bug report #15, 2026-08-06):
 *
 *   install.sh aborted mid-file on Windows and nothing said so. The script stopped, the
 *   caller rolled back, and `package.json` on that machine later reported the current
 *   version anyway — because a separate mechanism had pulled the working tree forward.
 *   So a machine could report v1.26.87 while its SessionStart hook, git hooks and
 *   scanner schedule had never been installed by any version.
 *
 *   The lesson is narrow and worth stating: **the version number is not evidence that
 *   installation completed.** Something has to look at the artifacts.
 *
 * This list is the single definition of "complete". install.sh asserts it at the end of a
 * run, and self-check.cjs reports it as its own item so a truncated install reaches a
 * human through the v1.26.87 alerting rather than waiting to be noticed.
 *
 * Adding an artifact here makes both of those check it. Do not add a second copy of the
 * list anywhere; two lists drift, and the one that drifts is always the one nobody reads.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseNodeCommand, isAbsolutePath, isNodeBasename } = require('./node-command.cjs');

/**
 * Two things this list deliberately does NOT do.
 *
 * It does not name a single blessed implementation of a hook. Windows has two installers
 * that produce different sets of files — `install.ps1` registers the Node hooks, Git Bash
 * `install.sh` registers the `.sh` ones — so `locate` returns every path that would satisfy
 * the artifact and presence of any one of them counts. Naming only one would report a
 * healthy `install.ps1` machine as broken, and this check feeds the v1.26.87 alerting: a
 * false `fail` is a broadcast telling someone to re-run an installer that will not change
 * anything.
 *
 * It does not check a directory when it can check a file inside it. `~/.claude/hooks/lib`
 * and `~/.ownmind/git-hooks` are both created by an unconditional `mkdir -p` that runs
 * *before* the copies that fill them, so an empty directory would pass while describing
 * itself as "git hooks (iron-rule verification at commit time)".
 *
 * @typedef {Object} Artifact
 * @property {string} id            stable identifier, used in messages
 * @property {string} describe      what a human should understand is missing
 * @property {(ctx: Ctx) => string[]} locate  candidate paths; any one present satisfies it
 * @property {'file'|'dir'} kind
 * @property {(ctx: Ctx) => boolean} [applies]  skip the artifact entirely when false
 * @property {boolean} [every]  every candidate must be present, not just one
 * @property {(target: string) => boolean} [verify]  a present file must also pass this
 *
 * @typedef {{home: string, ownmindDir: string}} Ctx
 */

const claudeHooks = ({ home }) => path.join(home, '.claude', 'hooks');

/**
 * The file the registered PreToolUse command would actually run, or null if no OwnMind entry
 * is registered at all.
 *
 * v1.26.105 — `iron_rule_hook` below asks whether a copy of the hook exists somewhere under
 * ~/.claude/hooks. On 2026-08-09 a machine passed that check while the command in
 * settings.json named a copy that could not start: same file, wrong directory, so its
 * `../shared/helpers.js` import resolved to a path no installer creates. The hook died on
 * every Bash call for months and this list reported 6/6.
 *
 * Presence of *a* copy is not evidence that the *registered* one runs — which is the same
 * lesson as the header, one level in. Reading the command closes that gap without new
 * machinery: the path it names is just another artifact that has to exist.
 */
function registeredIronRuleTarget({ home }) {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  } catch {
    // No settings file, or unreadable/malformed: nothing is registered that this can check,
    // and other artifacts already speak to a broken install. Skip rather than invent a fail.
    return null;
  }
  const groups = settings && settings.hooks && settings.hooks.PreToolUse;
  if (!Array.isArray(groups)) return null;

  for (const group of groups) {
    if (!group || !Array.isArray(group.hooks)) continue;
    for (const h of group.hooks) {
      if (!h || typeof h.command !== 'string') continue;
      // Both shapes in the wild: `bash ~/.claude/hooks/...sh` and `node "C:/.../...js"`.
      // Quoted first — a Windows path may contain spaces, so the quotes are the only
      // reliable boundary. Unquoted falls back to the whitespace-delimited token, which
      // must not swallow the interpreter name in front of it.
      const quoted = h.command.match(/["']([^"']*ownmind-iron-rule-check\.(?:sh|js))["']/);
      const bare = quoted ? null : h.command.match(/(\S*ownmind-iron-rule-check\.(?:sh|js))/);
      const m = quoted || bare;
      if (!m) continue;
      const raw = m[1].trim();
      return raw.startsWith('~/') || raw.startsWith('~\\')
        ? path.join(home, raw.slice(2))
        : raw;
    }
  }
  return null;
}

/**
 * Every absolute Node path the configuration tells Claude Code to run, in the order found.
 *
 * On a machine whose only Node is the private runtime, the installer writes that runtime's
 * absolute path as the MCP entry's command (~/.claude.json) and in front of each node-run hook
 * (settings.json). Bare `node` resolves through whatever PATH the caller has, so only the
 * absolute paths are this check's business: they are the ones that break silently when the
 * runtime is removed or truncated. Unreadable files yield nothing; other artifacts already
 * speak to a broken install.
 */
function configuredNodes({ home }) {
  const found = [];
  const add = (p) => { if (p && !found.includes(p)) found.push(p); };

  try {
    // Lazily: a half-updated checkout without this helper must not take the whole list down.
    const { readJson, CLAUDE_JSON } = require('./register-mcp.cjs');
    const entry = readJson(path.join(home, CLAUDE_JSON))?.mcpServers?.ownmind;
    const cmd = entry && typeof entry.command === 'string' ? entry.command : '';
    if (isAbsolutePath(cmd) && isNodeBasename(cmd)) add(cmd);
  } catch { /* nothing readable is configured */ }

  try {
    const raw = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
    const settings = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    for (const groups of Object.values((settings && settings.hooks) || {})) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        for (const h of (group && Array.isArray(group.hooks) ? group.hooks : [])) {
          const parsed = h && typeof h.command === 'string' ? parseNodeCommand(h.command) : null;
          // Only OwnMind's own runtime: a developer's own absolute-node hooks are not ours to judge.
          if (parsed && parsed.absolute && parsed.ownmind) add(parsed.runtime);
        }
      }
    }
  } catch { /* nothing readable is configured */ }

  return found;
}

/** True when `nodeBin` starts and prints a version — existing is not starting. */
function nodeRuns(nodeBin) {
  try {
    const out = execFileSync(nodeBin, ['--version'], {
      encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    return /^v\d+\./.test(String(out).trim());
  } catch {
    return false;
  }
}

/** @type {Artifact[]} */
const ARTIFACTS = [
  {
    id: 'session_start_hook',
    describe: 'SessionStart hook (this is what loads your memories automatically)',
    kind: 'file',
    // The Node hook is registered by absolute path into ~/.ownmind/hooks/ (see
    // session-hook-command.cjs), so that copy counts too.
    locate: (ctx) => [
      path.join(claudeHooks(ctx), 'ownmind-session-start.sh'),
      path.join(claudeHooks(ctx), 'ownmind-session-start.js'),
      path.join(ctx.ownmindDir, 'hooks', 'ownmind-session-start.js'),
    ],
  },
  {
    id: 'iron_rule_hook',
    describe: 'PreToolUse iron-rule hook',
    kind: 'file',
    // v1.26.105 — when a command is registered, that path is the only one that counts: it is
    // the file Claude Code will actually run. The list below is the fallback for a machine
    // with nothing registered yet, and used to be the whole check — which is how a machine
    // passed 6/6 while the command named a copy that could not start.
    locate: (ctx) => {
      const registered = registeredIronRuleTarget(ctx);
      if (registered) return [registered];
      // The .sh was retired: since v1.30.15 nothing registered it, and it is deleted now, so a
      // machine with nothing registered has exactly one file this could mean.
      return [path.join(claudeHooks(ctx), 'ownmind-iron-rule-check.js')];
    },
  },
  {
    id: 'iron_rule_hook_deps',
    describe: 'the module the registered PreToolUse hook imports on its first line',
    kind: 'file',
    // v1.26.105 — existing is not starting. On the machine measured on 2026-08-09 the
    // registered file was present: the two copies were byte-identical, so asking "is the
    // registered path there" answered yes while the hook died on every Bash call. What was
    // absent was `../shared/helpers.js` relative to it — ~/.claude/shared/, a directory no
    // installer creates. An ESM import that cannot resolve kills node before the first byte
    // of the payload runs, so this is the difference between registered and running.
    //
    // Only for the .js hook, and only when a command is registered: the .sh hook imports
    // nothing, and with nothing registered there is no path to judge (see iron_rule_hook's
    // fallback).
    applies: (ctx) => {
      const registered = registeredIronRuleTarget(ctx);
      return Boolean(registered) && registered.endsWith('.js');
    },
    // Never throws when nothing is registered: `locate` is called ahead of `applies` by
    // anything that enumerates the artifacts, so it has to return a path either way.
    locate: (ctx) => {
      const registered = registeredIronRuleTarget(ctx);
      const base = registered ? path.dirname(registered) : claudeHooks(ctx);
      return [path.join(base, '..', 'shared', 'helpers.js')];
    },
  },
  {
    id: 'hook_lib',
    describe: 'hooks/lib next to the bash SessionStart hook (it cannot render without it)',
    kind: 'file',
    // The bash hook resolves `lib/` relative to its own location
    // (`$SCRIPT_DIR/lib/session-start-output.js`), so this is required exactly when that
    // hook is the one installed. The Node hook runs out of ~/.ownmind/hooks/, where lib/
    // ships with the repo, and needs nothing here.
    applies: (ctx) => fs.existsSync(path.join(claudeHooks(ctx), 'ownmind-session-start.sh')),
    locate: (ctx) => [path.join(claudeHooks(ctx), 'lib', 'session-start-output.js')],
  },
  {
    id: 'git_hooks',
    describe: 'git hooks (iron-rule verification at commit time)',
    kind: 'file',
    locate: ({ ownmindDir }) => [path.join(ownmindDir, 'git-hooks', 'pre-commit')],
  },
  {
    // Its own entry, not a second candidate on the one above: candidates are satisfied by
    // ANY one being present, and pre-commit always is — so listing this beside it could
    // never have noticed the merge hook missing, which is the whole reason it was added.
    id: 'git_merge_hook',
    describe: 'git pre-merge-commit hook (a merge runs this one, never pre-commit)',
    kind: 'file',
    locate: ({ ownmindDir }) => [path.join(ownmindDir, 'git-hooks', 'pre-merge-commit')],
  },
  {
    id: 'memory_skill',
    describe: 'ownmind-memory skill',
    kind: 'file',
    locate: ({ home }) => [path.join(home, '.claude', 'skills', 'ownmind-memory', 'SKILL.md')],
  },
  {
    id: 'mcp_entry',
    describe: 'MCP server entry point',
    kind: 'file',
    locate: ({ ownmindDir }) => [path.join(ownmindDir, 'mcp', 'index.js')],
  },
  {
    // Only on a machine whose configuration names a Node by absolute path (the private runtime):
    // every one of them has to start, because Claude Code runs exactly that file and nothing
    // else. A machine on bare `node` is unaffected and checks the same count as before.
    id: 'configured_node',
    describe: 'the Node.js that Claude Code is configured to run for OwnMind (it must start)',
    kind: 'file',
    every: true,
    verify: nodeRuns,
    applies: (ctx) => configuredNodes(ctx).length > 0,
    // Never empty: `locate` is called ahead of `applies` by anything that enumerates the list.
    locate: (ctx) => {
      const nodes = configuredNodes(ctx);
      if (nodes.length) return nodes;
      return [process.platform === 'win32'
        ? path.join(ctx.ownmindDir, 'runtime', 'current', 'node.exe')
        : path.join(ctx.ownmindDir, 'runtime', 'current', 'bin', 'node')];
    },
  },
];

/**
 * Check every artifact and report the ones that are absent.
 *
 * Fails closed: an artifact whose presence cannot be determined (a permission error on
 * the stat, say) counts as missing. A completeness check that resolves ambiguity in
 * favour of "probably fine" is the thing this file exists to replace.
 *
 * @param {{home?: string, ownmindDir?: string}} [opts]
 * @returns {{ok: boolean, missing: {id: string, describe: string, path: string}[], checked: number}}
 */
function checkInstallArtifacts(opts = {}) {
  const home = opts.home || os.homedir();
  const ownmindDir = opts.ownmindDir || path.join(home, '.ownmind');
  const ctx = { home, ownmindDir };

  const missing = [];
  let checked = 0;

  for (const artifact of ARTIFACTS) {
    if (typeof artifact.applies === 'function' && !artifact.applies(ctx)) continue;
    checked += 1;
    const candidates = artifact.locate(ctx);
    const isPresent = (target) => {
      try {
        const st = fs.statSync(target);
        if (!(artifact.kind === 'dir' ? st.isDirectory() : st.isFile())) return false;
        return typeof artifact.verify === 'function' ? Boolean(artifact.verify(target)) : true;
      } catch {
        return false;
      }
    };
    if (artifact.every) {
      const absent = candidates.find((target) => !isPresent(target));
      if (absent !== undefined) {
        missing.push({ id: artifact.id, describe: artifact.describe, path: absent });
      }
    } else if (!candidates.some(isPresent)) {
      missing.push({ id: artifact.id, describe: artifact.describe, path: candidates[0] });
    }
  }

  return { ok: missing.length === 0, missing, checked };
}

module.exports = { ARTIFACTS, checkInstallArtifacts, configuredNodes };

// CLI: used by install.sh at the end of a run. Exit 1 and name what is missing.
if (require.main === module) {
  const args = process.argv.slice(2);
  const valueOf = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  // --home is accepted because every path install.sh writes derives from the shell's $HOME,
  // while os.homedir() reads USERPROFILE on Windows and the passwd entry on POSIX. Under
  // Git Bash those can differ, and the difference would report every artifact missing on a
  // healthy machine.
  const ownmindDir = valueOf('--ownmind-dir');
  const home = valueOf('--home') || os.homedir();
  const result = checkInstallArtifacts({ home, ownmindDir });
  const tilde = (p) => p.split(home).join('~');

  if (result.ok) {
    console.log(`install complete: ${result.checked}/${result.checked} artifacts present`);
    process.exit(0);
  }
  console.error(`install INCOMPLETE: ${result.missing.length} of ${result.checked} artifacts missing`);
  for (const m of result.missing) {
    console.error(`  - ${m.describe}`);
    console.error(`      expected at ${tilde(m.path)}`);
  }
  process.exit(1);
}
