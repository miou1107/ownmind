#!/usr/bin/env node
/**
 * v1.31.5 — the release check, by hand.
 *
 *   node ~/.ownmind/scripts/release-check.js [--base origin/main] [--milestone 2026-10]
 *   node ~/.ownmind/scripts/release-check.js --tag v1.2.3 [--milestone 2026-10]
 *
 * Run from inside the repository you are about to tag. Prints the same report the Bash hook
 * puts in front of `git tag`; with --tag it also records the tag on every reviewed card of
 * the milestone (refused while one is not reviewed). Exit code 1 when something blocks.
 */

import https from 'https';
import http from 'http';
import { readCredentials } from '../shared/helpers.js';
import { runReleaseCheck } from '../hooks/lib/release-check.js';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function postJson(url, apiKey, body) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const payload = JSON.stringify(body);
    const req = mod.request(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

async function main() {
  let apiKey = '';
  let apiUrl = '';
  try { ({ apiKey, apiUrl } = readCredentials()); } catch { /* the git half still runs */ }

  const result = await runReleaseCheck({ apiKey, apiUrl, base: arg('--base'), milestone: arg('--milestone') });
  console.log(result.lines.join('\n'));

  const tag = arg('--tag');
  if (tag) {
    if (result.blocking.length > 0) {
      console.log('\nOwnMind did not record the tag: fix the blocking line first.');
      process.exit(1);
    }
    if (!apiKey || !apiUrl || !result.project) {
      console.log(result.project
        ? '\nOwnMind did not record the tag: this machine has no OwnMind key, so the server cannot be told.'
        : '\nOwnMind did not record the tag: this folder is not inside a git repository.');
      process.exit(1);
    }
    const res = await postJson(`${apiUrl.replace(/\/$/, '')}/api/release/tag`, apiKey, {
      project: result.project, milestone: arg('--milestone') || '', tag,
    });
    const body = (() => { try { return JSON.parse(res.body); } catch { return {}; } })();
    if (res.status === 200) {
      console.log(`\nRecorded ${tag} on ${body.cards?.length ?? 0} reviewed card(s).`);
    } else if (res.status === 409) {
      console.log(`\nOwnMind did not record the tag: ${(body.cards || []).map((c) => `#${c.id} ${c.status}`).join(', ')} not reviewed yet. Review them in the console first.`);
      process.exit(1);
    } else {
      console.log('\nOwnMind did not record the tag: its server refused. Try again in a moment.');
      process.exit(1);
    }
  }
  process.exit(result.blocking.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`release-check failed: ${err?.message || err}`);
  process.exit(1);
});
