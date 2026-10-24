// The release archive a machine without git installs from is packed from the server's own tree
// (src/services/install-archive.js). In production that tree is the Docker image, so every
// top-level folder a client uses must be copied into the image; a folder missing there is
// silently missing on every no-git install while git installs have it.
//
// The list is computed from the tracked files: any new top-level entry fails this test until it
// is either copied by the Dockerfile or named below as not needed by a client.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Top-level entries a client install never reads: server-only code, the console source,
// development and CI files, documentation.
const NOT_FOR_CLIENTS = new Set([
  '.dockerignore', '.editorconfig', '.env.example', '.gitattributes', '.github', '.gitignore',
  '.mcp.json.example', 'CLAUDE.md', 'Dockerfile', 'FILELIST.md', 'README.md', 'client', 'db',
  'docker-compose.yml', 'docs', 'legacy', 'openspec', 'package-lock.json', 'tests',
  // CHANGELOG.md is copied for the server's own changelog page; src/ is copied whole (the
  // archive keeps only src/utils/ from it).
]);

function topLevelTracked() {
  const out = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' });
  return [...new Set(out.split('\n').filter(Boolean).map((f) => f.split('/')[0]))].sort();
}

function copiedByDockerfile(names) {
  const text = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
  const copied = new Set();
  for (const line of text.split('\n')) {
    const m = line.match(/^COPY\s+(?!--from)(.+)$/);
    if (!m) continue;
    const parts = m[1].trim().split(/\s+/);
    for (const src of parts.slice(0, -1)) {
      const top = src.replace(/\/+$/, '').split('/')[0];
      // `COPY package*.json ./` copies every tracked name the pattern matches.
      const re = new RegExp(`^${top.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
      for (const name of names) if (re.test(name)) copied.add(name);
    }
  }
  return copied;
}

function ignoredByDockerignore() {
  const lines = fs.readFileSync(path.join(repoRoot, '.dockerignore'), 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return new Set(lines.filter((l) => !l.startsWith('!') && !l.includes('/') && !l.includes('*')));
}

test('every top-level entry a client uses is copied into the server image', () => {
  const names = topLevelTracked();
  const copied = copiedByDockerfile(names);
  const missing = names.filter((name) => !NOT_FOR_CLIENTS.has(name) && !copied.has(name));
  assert.deepEqual(missing, [], `copy these into the image (Dockerfile) or list them as not needed by a client: ${missing.join(', ')}`);
});

test('no client folder is left out of the build context by .dockerignore', () => {
  const ignored = ignoredByDockerignore();
  const clash = topLevelTracked().filter((name) => !NOT_FOR_CLIENTS.has(name) && ignored.has(name));
  assert.deepEqual(clash, []);
});
