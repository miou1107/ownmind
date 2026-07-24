import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.87 — /api/me/pitfalls endpoint + me.js sensitive-event fix
 *
 * Background: before v1.17.86, the personal /me page showed 9 "missing observability"
 * warnings. Issues:
 *   1. The warnings are system bugs or AI behaviors, not something an individual user
 *      should worry about.
 *   2. Patterns only emerge from cross-user comparison.
 *   3. handoff_create was in the sensitive-event list, but activity.js autoEmit
 *      deliberately does not observe handoffs (over-inference). The two ends were
 *      inconsistent, so handoffs always landed in the unobserved-warning bucket.
 *
 * Fix (v1.17.87):
 *   1. me.js sensitive-event list drops handoff_create (aligns with activity.js).
 *   2. me.js personal page drops the three warnings compliance_unobserved /
 *      compliance_unverified / orphan_session.
 *   3. New /api/me/pitfalls endpoint aggregates across users; visible to anyone.
 *   4. memory.js save-iron_rule + disable handlers write a server-side system_auto
 *      compliance log, filling the 7-row missing-observability gap (autoEmit logic
 *      never reached the memory.js path).
 */

describe('v1.17.87 — me.js sensitive event list drops handoff_create', () => {
  const meSource = fs.readFileSync(path.join(repoRoot, 'src/routes/me.js'), 'utf8');

  it('sensitive-event CASE no longer contains handoff_create', () => {
    // Find the complianceGapQ CASE block.
    const m = meSource.match(/WITH sensitive AS \(([\s\S]+?)\),\s*\n\s*classified/);
    assert.ok(m, 'sensitive CTE not found');
    // Strip SQL line comments (-- ...) so explanatory mentions of handoff_create do not trigger a false positive.
    const sensCteCode = m[1].replace(/--[^\n]*/g, '');
    assert.doesNotMatch(sensCteCode, /handoff_create/,
      'me.js sensitive-event list must not contain handoff_create (align with activity.js autoEmit design)');
    // The two remaining sensitive events must still be present.
    assert.match(sensCteCode, /memory_disable/, 'memory_disable must remain');
    assert.match(sensCteCode, /memory_save.*type.*iron_rule/s, 'memory_save iron_rule must remain');
  });

  it('personal-page myAuditFindings no longer pushes compliance_unobserved / unverified / orphan_session', () => {
    const findingsBlock = meSource.match(/const myAuditFindings = \[\];([\s\S]+?)\/\/ P3:/);
    assert.ok(findingsBlock, 'myAuditFindings block not found');
    const block = findingsBlock[1];
    assert.doesNotMatch(block, /type:\s*['"]compliance_unobserved['"]/,
      'personal page no longer pushes compliance_unobserved (moved to /api/me/pitfalls)');
    assert.doesNotMatch(block, /type:\s*['"]compliance_unverified['"]/,
      'personal page no longer pushes compliance_unverified');
    assert.doesNotMatch(block, /type:\s*['"]orphan_session['"]/,
      'personal page no longer pushes orphan_session');
    // The three non-compliance warnings remain.
    assert.match(block, /heartbeat_absent/, 'heartbeat warning is kept');
    assert.match(block, /source_inconsistent/, 'source warning is kept');
  });
});

describe('v1.17.87 — /api/me/pitfalls endpoint structure', () => {
  const meSource = fs.readFileSync(path.join(repoRoot, 'src/routes/me.js'), 'utf8');

  it('me.js contains GET /pitfalls route', () => {
    assert.match(meSource, /router\.get\(['"]\/pitfalls['"]/,
      'me.js must register GET /pitfalls route');
  });

  it('endpoint joins across users (does not restrict user_id = req.user.id)', () => {
    // Find the pitfalls route body.
    const routeMatch = meSource.match(/router\.get\(['"]\/pitfalls['"][\s\S]+?(?=\nrouter\.|\nexport default)/);
    assert.ok(routeMatch, 'pitfalls route not found');
    const route = routeMatch[0];
    // Must JOIN users to pick up the name.
    assert.match(route, /JOIN users u ON u\.id = s\.user_id/,
      'pitfalls query must JOIN users to read the user name');
    // Must NOT include WHERE a.user_id = $1 restricting to a single user (cross-user is required).
    assert.ok(!/WHERE\s+a\.user_id\s*=\s*\$1/.test(route),
      'pitfalls must not restrict user_id = $1 (cross-user view required)');
  });

  it('all three sections (unobserved / unverified / orphan_session) have queries', () => {
    const routeMatch = meSource.match(/router\.get\(['"]\/pitfalls['"][\s\S]+?(?=\nrouter\.|\nexport default)/);
    const route = routeMatch[0];
    assert.match(route, /unobservedQ/, 'must define unobserved query');
    assert.match(route, /unverifiedQ/, 'must define unverified query');
    assert.match(route, /orphanQ/, 'must define orphan_session query');
  });

  it('each row contains four fields (when / what / impact / fix_hint)', () => {
    const routeMatch = meSource.match(/router\.get\(['"]\/pitfalls['"][\s\S]+?(?=\nrouter\.|\nexport default)/);
    const route = routeMatch[0];
    for (const field of ['when:', 'what,', 'impact:', 'fix_hint:']) {
      assert.match(route, new RegExp(field.replace(/[:.]/g, '\\$&')),
        `formatter must include the ${field} field`);
    }
  });

  it('supports window query param (7d / 30d / 90d / all)', () => {
    const routeMatch = meSource.match(/router\.get\(['"]\/pitfalls['"][\s\S]+?(?=\nrouter\.|\nexport default)/);
    const route = routeMatch[0];
    assert.match(route, /req\.query\.window/);
    assert.match(route, /['"]7d['"]/);
    assert.match(route, /['"]90d['"]/);
    assert.match(route, /['"]all['"]/);
  });
});

describe('v1.17.87 — memory.js save iron_rule + disable writes system_auto compliance log', () => {
  const memSource = fs.readFileSync(path.join(repoRoot, 'src/routes/memory.js'), 'utf8');

  it('save handler INSERTs iron_rule_compliance when type === iron_rule', () => {
    // Find the POST / block.
    const saveMatch = memSource.match(/router\.post\(['"]\/['"][\s\S]+?(?=\nrouter\.|\n\/\*\*)/);
    assert.ok(saveMatch, 'save POST route not found');
    const route = saveMatch[0];
    assert.match(route,
      /if \(type === ['"]iron_rule['"]\)[\s\S]{0,600}INSERT INTO activity_logs[\s\S]{0,200}iron_rule_compliance[\s\S]{0,400}system_server_auto/,
      'save handler must INSERT activity_logs event=iron_rule_compliance source=system_server_auto when type=iron_rule');
  });

  it('disable handler INSERTs iron_rule_compliance when type === iron_rule', () => {
    const disableMatch = memSource.match(/router\.put\(['"]\/:id\/disable['"][\s\S]+?(?=\nrouter\.|\n\/\*\*)/);
    assert.ok(disableMatch, 'disable PUT route not found');
    const route = disableMatch[0];
    assert.match(route,
      /if \(result\.rows\[0\]\.type === ['"]iron_rule['"]\)[\s\S]{0,600}INSERT INTO activity_logs[\s\S]{0,200}iron_rule_compliance[\s\S]{0,400}system_server_auto/,
      'disable handler must INSERT compliance log when type=iron_rule');
  });

  it('compliance log keys on the neutral full-layer-sync event, not a personal code (v1.26.32)', () => {
    // v1.26.32 de-identified: the backfill previously hardcoded rule_code=IR-006
    // (one user's personal rule). It now tags the neutral triggered_by_event and
    // leaves rule_code empty so it is not tied to any single user's numbering.
    assert.doesNotMatch(memSource, /rule_code:\s*['"]IR-\d+['"]/,
      'memory.js must not hardcode a personal iron-rule code');
    const emitCount = (memSource.match(/triggered_by_event:\s*RULE_FULL_LAYER_SYNC/g) || []).length;
    assert.ok(emitCount >= 2,
      'both save + disable backfills must tag the neutral RULE_FULL_LAYER_SYNC event');
  });

  it('compliance log action=observed_trigger (not comply)', () => {
    // system_auto records "observed a trigger", not "AI self-reported compliance".
    const matches = memSource.match(/action:\s*['"]observed_trigger['"]/g);
    assert.ok(matches && matches.length >= 2,
      'memory save / disable handlers must both use action=observed_trigger (at least 2 occurrences)');
  });

  it('INSERT failure must not block the main flow (try/catch)', () => {
    // Both handlers should wrap the INSERT in try/catch.
    const tryBlocks = memSource.match(/try \{\s*await query\(\s*`INSERT INTO activity_logs[\s\S]{0,800}\} catch/g);
    assert.ok(tryBlocks && tryBlocks.length >= 2,
      'compliance INSERTs in both save + disable must wrap try/catch to keep server failures from blocking the main flow');
  });
});

describe('v1.17.87 — me.html adds the "pitfalls" tab', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'src/public/me/index.html'), 'utf8');

  it('tab list includes the pitfalls button', () => {
    assert.match(html, /<button data-tab="pitfalls"[^>]*>🕳️ 踩坑紀錄<\/button>/);
  });

  it('tab-pitfalls container + three sections exist', () => {
    assert.match(html, /<div id="tab-pitfalls"/);
    assert.match(html, /pitfalls-section-unobserved/);
    assert.match(html, /pitfalls-section-unverified/);
    assert.match(html, /pitfalls-section-orphan/);
  });

  it('time-window dropdown has the four options 7d / 30d / 90d / all', () => {
    assert.match(html, /value="7d"/);
    assert.match(html, /value="30d"\s+selected/);
    assert.match(html, /value="90d"/);
    assert.match(html, /value="all"/);
  });

  it('loadPitfalls function fetches from /api/me/pitfalls', () => {
    assert.match(html, /async function loadPitfalls/);
    assert.match(html, /fetch\(`\/ownmind\/api\/me\/pitfalls\?window=/);
  });

  it('renderPitfalls uses <details> + summary for the expandable UI', () => {
    assert.match(html, /<details/);
    assert.match(html, /<summary/);
    // four field labels
    for (const label of ['何時：', '誰：', '發生情況：', '造成影響：', '建議修法：']) {
      assert.match(html, new RegExp(label),
        `expanded content must include the "${label}" field`);
    }
  });
});
