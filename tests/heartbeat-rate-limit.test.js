import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const eventsSource = readFileSync(
  join(__dirname, '..', 'src', 'routes', 'usage', 'events.js'),
  'utf8'
);

// Server-side rate limit: defense-in-depth against a misconfigured client
// that sends heartbeats faster than expected (even with the client's once-
// per-process cap). The UPSERT is guarded so a second heartbeat from the
// same (user, tool) within a short window is a no-op at the DB layer —
// atomic, zero extra round-trips.

test('writeHeartbeatIfPresent UPSERT is rate-limited via WHERE clause', () => {
  // Locate writeHeartbeatIfPresent body
  const fnStart = eventsSource.indexOf('async function writeHeartbeatIfPresent');
  assert.ok(fnStart > 0, 'expected writeHeartbeatIfPresent declaration');
  // v1.26.69: this used to be a fixed 1500-character slice, and adding four comment
  // lines and one OR condition to the SQL pushed the WHERE clause past the end of the
  // window. The guard then failed while the thing it guards was still correct, which is
  // the worst way for a test to fail. Cut at the function's closing brace instead.
  const fnEnd = eventsSource.indexOf('\n}', fnStart);
  assert.ok(fnEnd > fnStart, 'expected to find the end of writeHeartbeatIfPresent');
  const body = eventsSource.slice(fnStart, fnEnd);

  // Expect ON CONFLICT ... DO UPDATE SET ... WHERE clause that compares
  // last_reported_at against NOW() minus a rate-limit interval.
  // Be a bit flexible: accept any interval quantity (seconds / minutes),
  // but the pattern must be present.
  // Accept either a literal number (e.g. '30 seconds') OR a template
  // placeholder (e.g. '${HEARTBEAT_RATE_LIMIT_SECONDS} seconds'). Prefer
  // the named constant form, but don't break if someone inlines it later.
  const intervalPattern = /'(?:\$\{[A-Z_]+\}|\d+)\s*(?:second|minute)s?'/i;
  assert.match(
    body,
    new RegExp(
      'ON\\s+CONFLICT\\s*\\(\\s*user_id\\s*,\\s*tool\\s*\\)\\s*DO\\s+UPDATE\\s+SET[\\s\\S]+?WHERE\\s+collector_heartbeat\\.last_reported_at\\s*<\\s*NOW\\s*\\(\\s*\\)\\s*-\\s*INTERVAL\\s*' +
      intervalPattern.source,
      'i'
    ),
    'expected heartbeat UPSERT to have WHERE clause rate-limiting writes (ON CONFLICT DO UPDATE ... WHERE last_reported_at < NOW() - INTERVAL \'N seconds\')'
  );
});

test('rate-limit interval constant is a named constant, not a magic number', () => {
  // Guard against someone hard-coding `INTERVAL '30 seconds'` inline in the
  // SQL and then changing it to a different value in a refactor. Prefer
  // a named top-level constant.
  const hasNamedConstant = /const\s+HEARTBEAT_RATE_LIMIT_SECONDS\s*=\s*\d+/.test(eventsSource);
  assert.ok(
    hasNamedConstant,
    'expected a named constant like `const HEARTBEAT_RATE_LIMIT_SECONDS = 30` at module scope, so the rate-limit window is discoverable and tunable'
  );
});
