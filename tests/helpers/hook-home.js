import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

/**
 * A throwaway $HOME that hooks/ownmind-iron-rule-check.sh will run inside.
 *
 * That hook reaches for several things by absolute path under $HOME — its own version
 * string, the credentials, and three node helpers — so a test that spawns it has to build a
 * home for it first. Five test files were each doing that by hand, and the list of helpers
 * had already gone stale in all of them: v1.26.150 pointed the hook at a new one and eight
 * tests across four files failed, every one of them for the same missing symlink.
 *
 * That is the same defect the change causing it was fixing, one layer down — a rule written
 * in several places drifts in whichever place nobody edited. So the list lives here now.
 * Adding a helper to the hook means adding it to HOOK_HELPERS below and nowhere else.
 *
 * Symlinks, not copies, so an edit to a hook is picked up without restaging. Node resolves a
 * symlinked module from its real path, which is inside the repo, so `hooks/package.json` and
 * its `"type": "module"` are found there — the staged home needs no copy of it.
 *
 * @param {object}  opts
 * @param {string}  opts.apiUrl  — where the hook should look for the rules endpoint
 * @param {string} [opts.apiKey] — the key it should send
 * @param {string} [opts.version] — what ~/.ownmind/package.json should report
 * @returns {string} the staged home; pass it as HOME **and** USERPROFILE, and rm it after
 */
export function stageHookHome({ apiUrl, apiKey = 'test-key', version = '99.99.99' }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-hook-home-'));

  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify({
      mcpServers: { ownmind: { env: { OWNMIND_API_KEY: apiKey, OWNMIND_API_URL: apiUrl } } },
    })
  );

  fs.mkdirSync(path.join(home, '.ownmind', 'hooks'), { recursive: true });
  // Deliberately no ~/.ownmind/.git. Its absence is what keeps the hook's one-time upgrade
  // block — which runs `git pull` — from firing in the middle of a test run.
  fs.writeFileSync(path.join(home, '.ownmind', 'package.json'), JSON.stringify({ version }));

  fs.symlinkSync(path.join(repoRoot, 'shared'), path.join(home, '.ownmind', 'shared'));
  for (const helper of HOOK_HELPERS) {
    fs.symlinkSync(
      path.join(repoRoot, 'hooks', helper),
      path.join(home, '.ownmind', 'hooks', helper)
    );
  }

  return home;
}

/**
 * Every helper hooks/ownmind-iron-rule-check.sh runs as `node "$HOME/.ownmind/hooks/…"`.
 *
 * A name missing here does not make the hook fail — it makes it answer wrongly and keep
 * going, which is why the omission survived a full suite run before anyone noticed.
 */
export const HOOK_HELPERS = [
  // Classifies the command. Absent, every command comes back with no trigger at all.
  'ownmind-detect-trigger.js',
  // Runs the pre-action conditions on deploy/delete.
  'ownmind-verify-trigger.js',
  // Owns the whole Edit/Write path, which carries no command to classify.
  'ownmind-edit-reminder.js',
];
