/**
 * The server's own version, read once from package.json.
 *
 * Why this module exists
 * ----------------------
 * This IIFE used to be copy-pasted into src/routes/memory.js,
 * src/jobs/nightly-upgrade-reminder.js and src/routes/usage/admin-clients.js.
 * Three near-identical copies were harmless in themselves, but they established
 * the pattern that the version is something each consumer restates — and a fourth
 * copy, hardcoded as the string 'v1.20.1' in client/src/App.jsx, then sat in the
 * dashboard footer from v1.20.1 onward without anyone noticing.
 *
 * Keeping one definition means package.json is the only place a version lives on
 * the server side, and the dashboard reads it over the wire rather than
 * declaring its own.
 *
 * Falls back to '0.0.0' rather than throwing: a server that cannot read its own
 * manifest should still boot and serve memories. Every consumer treats '0.0.0'
 * as "older than anything", so the upgrade reminder degrades to advertising an
 * upgrade rather than silently suppressing one.
 */

import { createRequire } from 'node:module';

/**
 * Exposed as a seam so the fallback branch is reachable from a test: pass a
 * `requireFn` that throws, or that returns a manifest with no version.
 *
 * @param {(id: string) => { version?: string }} requireFn
 * @returns {string}
 */
export function readPackageVersion(requireFn) {
  try {
    return requireFn('../../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const SERVER_VERSION = readPackageVersion(createRequire(import.meta.url));
