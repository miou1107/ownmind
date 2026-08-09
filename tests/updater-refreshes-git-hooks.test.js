/**
 * v1.26.104 — the updaters keep the installed git hook wrappers current
 *
 * `~/.ownmind` IS the git checkout, so a `git pull` replaces everything under `hooks/`
 * the instant it lands. `~/.ownmind/git-hooks/` is different: those are COPIES that
 * install.sh / install.ps1 made, and the auto-update path
 *
 *     mcp/index.js → git pull → npm install → scripts/update.sh
 *
 * never runs an installer. Before v1.26.104 the updaters only stripped CR from those
 * copies, on the stated reasoning that "this script does not own their content".
 *
 * That reasoning cost this very release its enforcement. v1.26.104 moves commit-message
 * rules OUT of pre-commit and INTO commit-msg. An auto-updating user would have received
 * the new pre-commit immediately — which no longer checks messages — while keeping a
 * commit-msg wrapper from whenever they last ran an installer, which never calls the new
 * script. Net effect: message rules silently stop being enforced, and the one rule that
 * appears to still work (the hardcoded trailer grep, present in the old wrapper too) hides
 * it.
 *
 * The list of wrappers is derived from install.sh rather than written here, because a
 * hand-maintained list is exactly what drifted in the first place.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(
  import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),
  '..'
);

const installSh = fs.readFileSync(path.join(repoRoot, 'install.sh'), 'utf8');
const updateSh = fs.readFileSync(path.join(repoRoot, 'scripts', 'update.sh'), 'utf8');
const updatePs1 = fs.readFileSync(path.join(repoRoot, 'scripts', 'update.ps1'), 'utf8');

/** Every wrapper install.sh installs: `install_git_hook "ownmind-git-X" "X"`. */
function installedHookNames() {
  const names = [];
  const re = /install_git_hook\s+"ownmind-git-([a-z-]+)"\s+"([a-z-]+)"/g;
  let m;
  while ((m = re.exec(installSh)) !== null) names.push(m[2]);
  return names;
}

describe('v1.26.104 — updaters refresh every installed git hook wrapper', () => {
  it('install.sh installs the wrappers this test expects to find', () => {
    const names = installedHookNames();
    assert.ok(names.length >= 3,
      `expected to derive the wrapper list from install.sh, got ${JSON.stringify(names)}`);
    assert.deepEqual([...names].sort(), ['commit-msg', 'post-commit', 'pre-commit']);
  });

  it('update.sh refreshes each one from the checkout, not merely repairs line endings', () => {
    for (const name of installedHookNames()) {
      assert.match(updateSh, new RegExp(`ownmind-git-\\$gh_name|ownmind-git-${name}`),
        `update.sh must copy ${name} from hooks/, or a client keeps a stale wrapper forever`);
    }
    // The specific regression: copying from the checkout, not just `tr -d '\\015'`.
    assert.match(updateSh, /gh_src="\$OWNMIND_DIR\/hooks\/ownmind-git-\$gh_name"/,
      'update.sh must resolve each wrapper\'s source in the checkout');
  });

  it('update.ps1 does the same, so Windows does not diverge', () => {
    assert.match(updatePs1, /ownmind-git-\$ghName/,
      'update.ps1 must copy the wrappers too — it previously did not touch them at all');
    for (const name of installedHookNames()) {
      assert.ok(updatePs1.includes(`"${name}"`),
        `update.ps1 must include ${name} in the set it refreshes`);
    }
  });

  it('neither updater creates a wrapper that was never installed', () => {
    // Refreshing is not the same as enabling. A machine whose owner never asked for
    // OwnMind's git hooks must not acquire them from an update.
    assert.match(updateSh, /\[ -f "\$gh" \] \|\| continue/,
      'update.sh must skip wrappers that are not already present');
    assert.match(updatePs1, /if \(-not \(Test-Path \$ghDest\)\) \{ continue \}/,
      'update.ps1 must skip wrappers that are not already present');
  });
});
