#!/usr/bin/env node
/**
 * v1.26.129 — CLI shim so the shell hook can queue an update banner.
 *
 * The shell updater runs inside a detached `( … ) &` subshell and has no way to import an ES
 * module. It already shells out to `hooks/lib/*.js` for the same reason, so the message text
 * stays in one place (shared/update-banner.js) rather than being written twice in two
 * languages — which is how the tip list ended up duplicated.
 *
 * Usage:
 *   node hooks/lib/queue-update-banner.js applied [version]
 *   node hooks/lib/queue-update-banner.js failed <step>
 *
 * `applied` with no version reads it off disk here. The caller is the shell updater, and
 * having it interpolate a version into a `node -e` one-liner is how quoting bugs get written;
 * the read also has to happen after the pull, which is exactly when this runs.
 *
 * Always exits 0. This runs at the tail of an update that has already finished; a non-zero
 * exit here would surface as an update failure that did not happen.
 */

import { queueUpdateBanner } from '../../shared/update-banner.js';
import { getClientVersion } from '../../shared/helpers.js';

const [outcome, arg] = process.argv.slice(2);
try {
  queueUpdateBanner({
    outcome,
    version: outcome === 'applied' ? (arg || getClientVersion()) : undefined,
    step: outcome === 'failed' ? arg : undefined,
  });
} catch { /* never let this be the thing that fails */ }
process.exit(0);
