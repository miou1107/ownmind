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
 *
 * @typedef {{home: string, ownmindDir: string}} Ctx
 */

const claudeHooks = ({ home }) => path.join(home, '.claude', 'hooks');

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
    locate: (ctx) => [
      path.join(claudeHooks(ctx), 'ownmind-iron-rule-check.sh'),
      path.join(claudeHooks(ctx), 'ownmind-iron-rule-check.js'),
    ],
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
    const present = candidates.some((target) => {
      try {
        const st = fs.statSync(target);
        return artifact.kind === 'dir' ? st.isDirectory() : st.isFile();
      } catch {
        return false;
      }
    });
    if (!present) {
      missing.push({ id: artifact.id, describe: artifact.describe, path: candidates[0] });
    }
  }

  return { ok: missing.length === 0, missing, checked };
}

module.exports = { ARTIFACTS, checkInstallArtifacts };

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
