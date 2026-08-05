#!/usr/bin/env node
/**
 * Make sure the console has been built before the server starts.
 *
 * Why this exists: `src/public/dashboard/` is gitignored (.gitignore), so a fresh clone
 * has no console at all. That was survivable while the legacy `/admin` console was a
 * checked-in HTML file — `/` redirected somewhere that always rendered. v1.26.59 retired
 * it and v1.26.60 moved it out of `src/`, so on a fresh clone `npm start` would serve a
 * redirect into a 404 with nothing explaining why.
 *
 * The alternative was committing the build output. That keeps the clone self-sufficient
 * at the cost of a large diff on every front-end change, and a build artefact in review
 * is noise that hides the change that produced it. Building on demand keeps git clean.
 *
 * Runs as `prestart`, so it is skipped by `npm run dev` and by the container, which
 * already has the artefact from the Docker build stage. When the build is present this
 * costs one `existsSync`.
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const shell = process.platform === 'win32';

const shellHtml = join(repoRoot, 'src', 'public', 'dashboard', 'index.html');
if (existsSync(shellHtml)) process.exit(0);

console.log('[ensure-console-build] no console build found, building it once…');

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell });
  if (r.status !== 0) {
    console.error(
      `\n[ensure-console-build] \`${cmd} ${args.join(' ')}\` failed.\n`
      + 'Build the console by hand and start again:\n'
      + '  cd client && npm install && npm run build:no-translate\n',
    );
    process.exit(1);
  }
}

const clientDir = join(repoRoot, 'client');
if (!existsSync(join(clientDir, 'node_modules'))) {
  run('npm', ['install'], clientDir);
}
// `build:no-translate`, not `build`: the full script also runs the LLM translation pass,
// which needs credentials and network. Starting a server must not depend on either. The
// checked-in dictionaries are what ships anyway.
run('npm', ['run', 'build:no-translate'], clientDir);

if (!existsSync(shellHtml)) {
  console.error('[ensure-console-build] build reported success but produced no shell; aborting.');
  process.exit(1);
}
console.log('[ensure-console-build] console built.');
