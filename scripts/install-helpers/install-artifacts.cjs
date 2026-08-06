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
 * @typedef {Object} Artifact
 * @property {string} id            stable identifier, used in messages
 * @property {string} describe      what a human should understand is missing
 * @property {(ctx: {home: string, ownmindDir: string}) => string} locate  absolute path
 * @property {'file'|'dir'} kind
 * @property {(ctx: {home: string, ownmindDir: string}) => boolean} [applies]
 */

/** @type {Artifact[]} */
const ARTIFACTS = [
  {
    id: 'session_start_hook',
    describe: 'SessionStart hook (this is what loads your memories automatically)',
    kind: 'file',
    locate: ({ home }) => path.join(home, '.claude', 'hooks', 'ownmind-session-start.sh'),
  },
  {
    id: 'iron_rule_hook',
    describe: 'PreToolUse iron-rule hook',
    kind: 'file',
    locate: ({ home }) => path.join(home, '.claude', 'hooks', 'ownmind-iron-rule-check.sh'),
  },
  {
    id: 'hook_lib',
    describe: 'hooks/lib (the SessionStart hook cannot render without it)',
    kind: 'dir',
    locate: ({ home }) => path.join(home, '.claude', 'hooks', 'lib'),
  },
  {
    id: 'git_hooks',
    describe: 'git hooks (iron-rule verification at commit time)',
    kind: 'dir',
    locate: ({ ownmindDir }) => path.join(ownmindDir, 'git-hooks'),
  },
  {
    id: 'memory_skill',
    describe: 'ownmind-memory skill',
    kind: 'file',
    locate: ({ home }) => path.join(home, '.claude', 'skills', 'ownmind-memory', 'SKILL.md'),
  },
  {
    id: 'mcp_entry',
    describe: 'MCP server entry point',
    kind: 'file',
    locate: ({ ownmindDir }) => path.join(ownmindDir, 'mcp', 'index.js'),
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
    const target = artifact.locate(ctx);
    let present = false;
    try {
      const st = fs.statSync(target);
      present = artifact.kind === 'dir' ? st.isDirectory() : st.isFile();
    } catch {
      present = false;
    }
    if (!present) {
      missing.push({ id: artifact.id, describe: artifact.describe, path: target });
    }
  }

  return { ok: missing.length === 0, missing, checked };
}

module.exports = { ARTIFACTS, checkInstallArtifacts };

// CLI: used by install.sh at the end of a run. Exit 1 and name what is missing.
if (require.main === module) {
  const args = process.argv.slice(2);
  const dirArg = args.indexOf('--ownmind-dir');
  const ownmindDir = dirArg >= 0 ? args[dirArg + 1] : undefined;
  const result = checkInstallArtifacts({ ownmindDir });
  const home = os.homedir();
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
