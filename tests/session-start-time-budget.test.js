/**
 * Issue #200, item 6 — the session-start hooks stay inside Claude Code's 10-second limit.
 *
 * The memory sync itself is bounded in conditional-sync.js (tested in conditional-sync.test.js).
 * These pin the callers: the waits around that sync used to add up past the limit on their own.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const sh = read('hooks/ownmind-session-start.sh');
const cli = read('hooks/lib/conditional-sync-cli.js');
const js = read('hooks/ownmind-session-start.js');

describe('issue #200 — session start fits in the hook time limit', () => {
  it('the shell hook gives the sync helper 7 seconds, not 10', () => {
    assert.match(sh, /timeout 7 node "\$LIB_DIR\/conditional-sync-cli\.js"/);
    assert.doesNotMatch(sh, /timeout 10 node "\$LIB_DIR\/conditional-sync-cli\.js"/);
  });

  it('the direct-request fallback runs only when the helper gave up quickly', () => {
    const at = sh.indexOf('/api/memory/init?compact=true');
    const guard = sh.slice(sh.lastIndexOf('if [', at), at);
    assert.match(guard, /\$\(\(SECONDS - SYNC_STARTED\)\) -le 2/);
    assert.match(sh.slice(at - 200, at), /--max-time 3/);
  });

  it('the announcements request is started before the sync and collected after it', () => {
    const started = sh.indexOf('BROADCAST_PID=$!');
    const sync = sh.indexOf('conditional-sync-cli.js" \\');
    const collected = sh.indexOf('wait "$BROADCAST_PID"');
    assert.ok(started > 0 && sync > started && collected > sync, 'started → sync → collected');
    // Its output goes to a file: a background job holding the hook's stdout would keep Claude
    // Code waiting on it.
    assert.match(sh.slice(started - 400, started), /> "\$BROADCAST_FILE" 2>\/dev\/null &/);
  });

  it('the memory-file sync after the output runs in the background, silent', () => {
    const at = sh.indexOf('/api/memory/sync?types=iron_rule,project,feedback');
    assert.ok(at > sh.indexOf('session-start-output.js'), 'it comes after the memories are printed');
    const tail = sh.slice(at);
    assert.match(tail, /\) >\/dev\/null 2>&1 &\nfi/, 'the block is a background subshell with no output');
  });

  it('both hooks pass the session-start budget and run the enforcement sync alongside', () => {
    assert.match(cli, /runConditionalSync\(\{ apiUrl, apiKey, budgetMs: SESSION_START_BUDGET_MS \}\)/);
    assert.match(cli, /Promise\.all\(\[\s*syncEnforcementBundle\(apiUrl, apiKey\),\s*runConditionalSync/);
    assert.match(js, /runConditionalSync\(\{ apiUrl, apiKey, budgetMs: SESSION_START_BUDGET_MS \}\)/);
    const started = js.indexOf('const enforcement = syncEnforcementBundle(apiUrl, apiKey)');
    const synced = js.indexOf('budgetMs: SESSION_START_BUDGET_MS');
    const awaited = js.indexOf('await enforcement;');
    assert.ok(started > 0 && synced > started && awaited > synced);
  });
});
