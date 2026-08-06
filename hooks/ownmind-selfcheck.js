#!/usr/bin/env node
/**
 * hooks/ownmind-selfcheck.js
 *
 * Run one scan, then ask the server whether it now holds this machine's data, and say so
 * in words a non-engineer can act on.
 *
 * This runs at the end of an install or upgrade, which is the one moment somebody is
 * present and paying attention, and by hand when diagnosing a machine.
 *
 * Two rules shape everything below:
 *
 *   1. **It must never fail an installation.** A network problem, an old server, a lock
 *      held by a scheduled scan — all of those are reported and exit 0. A diagnostic that
 *      can break the thing it is checking is a worse defect than the one it detects.
 *   2. **It must exit non-zero when a tool is genuinely not reaching the server**, because
 *      every layer above reads exit codes, and that is exactly how the collector failures
 *      of the past week stayed invisible: everything reported success.
 */

import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { buildSelfCheckReport, renderSelfCheckReport, fetchSelfCheck }
  from '../shared/scanners/selfcheck.js';
import { readCredentials } from '../shared/helpers.js';

/**
 * @param {object} deps  everything injected, so the interesting paths are testable
 *   scan()        → { machine, scannerVersion, scanned[] } | undefined when locked out
 *   fetch(creds)  → { ok, data } | { ok, error }
 *   credentials() → { apiUrl, apiKey }
 *   print(line)
 * @returns {{exitCode: number, report: object|null}}
 */
export async function runSelfCheck({
  scan, fetch: fetchFn, credentials, print = console.log
} = {}) {
  print('');
  print('OwnMind — checking that this machine\'s usage data reaches the server');
  print('');

  let apiUrl, apiKey;
  try {
    ({ apiUrl, apiKey } = credentials() ?? {});
  } catch (err) {
    return done(print, 0, `  Could not read credentials: ${redact(err.message, null)}`);
  }
  if (!apiUrl || !apiKey) {
    return done(print, 0,
      '  No credentials in ~/.claude/settings.json (mcpServers.ownmind.env).\n'
      + '  Nothing can be reported until OwnMind is connected to a server.');
  }

  let local;
  try {
    local = await scan();
  } catch (err) {
    return done(print, 0, `  The scan did not finish: ${redact(err.message, apiKey)}`);
  }
  if (!local) {
    return done(print, 0,
      '  Another scan is already running on this machine, so this one was skipped.\n'
      + '  Wait a minute and run this check again.');
  }

  const answer = await fetchFn({ apiUrl, apiKey });
  if (!answer?.ok) {
    return done(print, 0,
      `  Could not ask the server: ${redact(answer?.error ?? 'unknown error', apiKey)}\n`
      + '  The scan itself ran; this check just could not confirm the other end.');
  }

  const report = buildSelfCheckReport({
    machine: local.machine ?? os.hostname(),
    scanned: local.scanned ?? [],
    serverTools: answer.data.tools,
    serverTime: answer.data.server_time
  });

  print(renderSelfCheckReport(report));
  print('');
  return { exitCode: report.ok ? 0 : 1, report };
}

function done(print, exitCode, message) {
  print(message);
  print('');
  return { exitCode, report: null };
}

/**
 * An error message can carry the url it was given, and the url can carry the key.
 * Nothing this file prints is worth leaking a credential over.
 */
const MIN_REDACTABLE_KEY = 8;

function redact(message, apiKey) {
  let out = String(message ?? '');
  // Long enough that a match is the key and not a coincidence. Splitting on a two-letter
  // "key" would turn "lock held" into "loc*** held" and hide the actual error, which is
  // the opposite of what this file is for.
  if (apiKey && String(apiKey).length >= MIN_REDACTABLE_KEY) {
    out = out.split(apiKey).join('***');
  }
  return out.replace(/([?&](?:api[-_]?key|key|token)=)[^&\s]+/gi, '$1***');
}

/* c8 ignore start — process wiring, exercised by running the file */
const isDirectRun = process.argv[1] && (() => {
  try { return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]); }
  catch { return false; }
})();

if (isDirectRun) {
  const { main } = await import('./ownmind-usage-scanner.js');
  const { exitCode } = await runSelfCheck({
    scan: main,
    fetch: fetchSelfCheck,
    credentials: () => readCredentials()
  });
  process.exit(exitCode);
}
/* c8 ignore stop */
