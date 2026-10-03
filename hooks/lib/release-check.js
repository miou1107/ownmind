/**
 * v1.31.5 — run the release check from the Bash hook or the CLI, with git and the network
 * injected so the decision is testable.
 *
 * Returns { blocking, lines, project }. `blocking` non-empty means the hook denies the tag;
 * everything in `lines` is for the person to read. The server half fails open (the git half
 * still answers); the git half failing to find a base is reported, not treated as blocking,
 * because blocking a release on a guess would be worse than the rule it enforces.
 */

import path from 'path';
import { execFileSync } from 'child_process';
import https from 'https';
import http from 'http';
import { gitFacts, buildReleaseReport } from '../../shared/release-git.js';

const SERVER_TIMEOUT_MS = 5000;

export function defaultGit(cwd) {
  return (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

export function getJson(url, apiKey, timeout = SERVER_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { Authorization: `Bearer ${apiKey}` }, timeout }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/** The project name is the repository's top-level folder name, never its path; null outside
 *  a repository, so the server is never asked about — and never writes a tag onto — a project
 *  named after whatever folder the shell happened to be in. */
export function projectNameOf(git) {
  try {
    const top = git(['rev-parse', '--show-toplevel']).trim();
    if (top) return path.basename(top);
  } catch { /* not a repository */ }
  return null;
}

/**
 * @param {object} opts
 * @param {string} [opts.apiKey]
 * @param {string} [opts.apiUrl]
 * @param {string} [opts.cwd]
 * @param {string} [opts.base]        --base override
 * @param {string} [opts.milestone]
 * @param {Function} [opts.git]       injected git
 * @param {Function} [opts.fetchJson] injected network (url, apiKey) → { status, body }
 */
export async function runReleaseCheck({
  apiKey = '', apiUrl = '', cwd = process.cwd(), base, milestone,
  git = defaultGit(cwd), fetchJson = getJson,
} = {}) {
  const facts = gitFacts(git, { base });
  const project = projectNameOf(git);

  let server = null;
  if (apiKey && apiUrl && project) {
    try {
      const qs = new URLSearchParams({ project });
      if (milestone) qs.set('milestone', milestone);
      if (facts.since) qs.set('since', facts.since);
      const res = await fetchJson(`${apiUrl.replace(/\/$/, '')}/api/release/check?${qs}`, apiKey);
      if (res.status === 200) server = JSON.parse(res.body);
    } catch { /* reported as "could not ask" by the report */ }
  }

  const report = buildReleaseReport(facts, server);
  return { ...report, project, facts };
}

/** What the hook prints: a deny envelope when something blocks, context otherwise. */
export function releaseEnvelope(version, result) {
  const header = `[OwnMind v${version}] Release check`;
  const text = [header, ...result.lines].join('\n');
  if (result.blocking.length > 0) {
    const reason = `${text}\n\nResponse format: the AI's first line must be "${header}".`;
    return JSON.stringify({
      decision: 'block',
      reason,
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    });
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `${text}\nShow the "For you to read" part to the user, in their language, before the tag goes out.`,
    },
  });
}
