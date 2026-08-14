import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.js';

/**
 * v1.17.71 — hooks/ownmind-tty-echo.cjs (OwnMind presence indicator / IR-027 program-logic gate)
 *
 * Background: from v1.17.0 onwards, MCP tool results end with a
 * "[OwnMind vX.Y.Z] XXX: YYY" banner so the user sees OwnMind is active.
 * But Claude Code UI collapses tool results — users do not see them — and
 * the AI often swallows them and never relays. Vin's three specs:
 *   1. Compliance reports being frequent is fine; the user must see every OwnMind action.
 *   2. Banners produced in one trigger should merge into a single signature block.
 *   3. The AI must not be able to filter / swallow them → fallback must not use
 *      stderr / additionalContext.
 *
 * Primary path: write to /dev/tty (mac/linux) or \\.\CONOUT$ (Windows), bypassing
 * the Claude Code hook output pipeline, writing directly to the user's terminal device.
 *
 * Fallback: when tty cannot be written (SSH without -t / nohup / detached) → write
 * ~/.ownmind/logs/banner-pending.jsonl; the next SessionStart hook reprints them at
 * the top of the next session. Never use stderr / additionalContext (the AI eats them).
 */

const repoRoot = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');
const hookPath = path.join(repoRoot, 'hooks', 'ownmind-tty-echo.cjs');

let tmpHome;
let pendingFile;

function runHook(input, env = {}) {
  return spawnSync('node', [hookPath], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    // Task 4 (hook message i18n) wired the merged-banner header through t(); pinned
    // defensively even though the header carries no linguistic content (identical en/zh).
    env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, OWNMIND_LOCALE_FORCE: 'en', ...env },
  });
}

function setupTmpHome() {
  tmpHome = tempDir('ownmind-tty-test-');
  fs.mkdirSync(path.join(tmpHome, '.ownmind', 'logs'), { recursive: true });
  pendingFile = path.join(tmpHome, '.ownmind', 'logs', 'banner-pending.jsonl');
}

function cleanupTmpHome() {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

/**
 * v1.17.73 — structural IR-007 mine clearance (M-1)
 *
 * Mine hit during v1.17.71 → v1.17.72: all 19 fixtures used shape (B)
 * (tool_response: { content: [...] }), but the Claude Code prod MCP tool actually
 * sends shape (A) (tool_response: [...] direct array). With every fixture using the
 * wrong shape uniformly → 803/803 tests passed but prod extracted 0% of banners.
 * Classic "tests don't constrain prod because fixtures share a collective false positive."
 *
 * Mine clearance: extract fixture builders into two helpers and mix them across tests
 * so "one typo no longer breaks everything." New tests must also explicitly mark
 * which shape they use.
 *
 * Maps to prod:
 *   mcpToolResponse    → real Claude Code MCP tool (mcp__ownmind__*) shape
 *   legacyToolResponse → legacy / non-MCP tool shape (may still appear)
 */
function mcpToolResponse(parts) {
  return parts;
}

function legacyToolResponse(parts) {
  return { content: parts };
}

describe('v1.17.71 — ownmind-tty-echo.cjs banner extraction', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('module file exists + can be spawned directly with node', () => {
    assert.ok(fs.existsSync(hookPath), 'hooks/ownmind-tty-echo.cjs must exist');
    const r = runHook('{}');
    assert.equal(r.status, 0, 'empty input must still exit 0 cleanly without crashing');
  });

  it('extracts every line starting with [OwnMind...] from tool_response.content[*].text (legacy shape)', () => {
    // Intentionally use legacy {content: [...]} shape — make sure the legacy / non-MCP channel still works.
    const input = {
      tool_name: 'mcp__ownmind__ownmind_search',
      tool_response: legacyToolResponse([
        { type: 'text', text: '【OwnMind v1.17.71】記憶搜尋：\n{"data":[],"hits":0}\n\n【OwnMind v1.17.71】技巧提示：你可以搜尋記憶' },
      ]),
    };
    // Force the fallback path (test env has no writable /dev/tty) → writes pending file.
    const r = runHook(input, { OWNMIND_TTY_FORCE_FALLBACK: '1' });
    assert.equal(r.status, 0);
    assert.ok(fs.existsSync(pendingFile), 'fallback should write banner-pending.jsonl');
    const content = fs.readFileSync(pendingFile, 'utf8');
    assert.match(content, /記憶搜尋/);
    assert.match(content, /技巧提示/);
  });

  it('does not write pending file when there is no [OwnMind] banner (no pollution)', () => {
    const input = {
      tool_name: 'mcp__ownmind__ownmind_search',
      tool_response: mcpToolResponse([{ type: 'text', text: '純 JSON 沒 banner' }]),
    };
    const r = runHook(input, { OWNMIND_TTY_FORCE_FALLBACK: '1' });
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(pendingFile), false,
      'should not touch pending file when there is no banner');
  });

  it('multiple banners in one trigger merge into a single "signature header + indented list" block', () => {
    const input = {
      tool_name: 'mcp__ownmind__ownmind_get',
      tool_response: mcpToolResponse([
        { type: 'text', text: '【OwnMind v1.17.71】鐵律提醒：[IR-007]\n{...}\n\n【OwnMind v1.17.71】技巧提示：鐵律不會被刪除' },
      ]),
    };
    const r = runHook(input, { OWNMIND_TTY_FORCE_FALLBACK: '1' });
    const content = fs.readFileSync(pendingFile, 'utf8');
    const record = JSON.parse(content.trim().split('\n').pop());
    const block = record.block;
    // Header: [OwnMind v1.22.0+] sits alone on the first line (v1.22.0 switched to ASCII brackets).
    assert.match(block, /^\[OwnMind v[\d.]+\]\n/, 'signature header must be on its own first line');
    // Subsequent lines must not repeat the prefix.
    const lines = block.trim().split('\n');
    const tail = lines.slice(1).join('\n');
    assert.ok(!tail.includes('[OwnMind v') && !tail.includes('【OwnMind v'),
      'signature prefix must not repeat on subsequent lines (merged into one block)');
    // Body is listed indented.
    assert.match(block, /鐵律提醒/);
    assert.match(block, /技巧提示/);
  });

  it('supports multiple content parts (legacy shape — occasionally still arrives as multi-part)', () => {
    // Intentionally use legacy {content: [...]} shape — multi-part is more common on the legacy channel.
    const input = {
      tool_name: 'mcp__ownmind__ownmind_init',
      tool_response: legacyToolResponse([
        { type: 'text', text: '【OwnMind v1.17.71】記憶載入：已載入' },
        { type: 'text', text: '【OwnMind v1.17.71】技巧提示：你可以說「記起來」' },
      ]),
    };
    const r = runHook(input, { OWNMIND_TTY_FORCE_FALLBACK: '1' });
    const content = fs.readFileSync(pendingFile, 'utf8');
    assert.match(content, /記憶載入/);
    assert.match(content, /技巧提示/);
  });

  it('supports broadcast banners (starting with the broadcast prefix) — must also be captured', () => {
    const input = {
      tool_name: 'mcp__ownmind__ownmind_search',
      tool_response: mcpToolResponse([
        { type: 'text', text: '📢 OwnMind 系統通知\n[INFO] 升級到 v1.17.71\n---\n\n【OwnMind v1.17.71】記憶搜尋：...' },
      ]),
    };
    const r = runHook(input, { OWNMIND_TTY_FORCE_FALLBACK: '1' });
    const content = fs.readFileSync(pendingFile, 'utf8');
    assert.match(content, /OwnMind 系統通知/);
  });

  it('IR-007 regression: tool_response as a direct array (the real Claude Code prod shape)', () => {
    // Background: after v1.17.71 shipped, presence indicators failed 100% in prod.
    // Tracing showed stdin had data, the hook ran, but banner_count stayed 0.
    // Root cause: the PostToolUse JSON Claude Code sends is `tool_response: [{type, text}, ...]`
    // (a direct array), not the `tool_response: { content: [...] }` the hook expected.
    // Every original fixture used the latter, so tests stayed green while prod
    // extracted nothing.
    //
    // This test uses the real captured PostToolUse stdin to guarantee the prod shape is handled.
    const input = {
      session_id: '7e090be5-a795-4ea7-8a5a-699fc953c175',
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__ownmind__ownmind_search',
      tool_input: { query: 'capture full json' },
      tool_response: [
        {
          type: 'text',
          text: '【OwnMind v1.17.71】記憶搜尋：\n{\n  "data": [],\n  "memory_hits": 0,\n  "session_hits": 0\n}\n\n【OwnMind v1.17.71】技巧提示：記憶分短期和長期：session log 會自動壓縮，鐵律和決策永久保留',
        },
      ],
      tool_use_id: 'toolu_019gnX792kxsc3qL4AQQtVF7',
    };
    const r = runHook(input, { OWNMIND_TTY_FORCE_FALLBACK: '1' });
    assert.equal(r.status, 0);
    assert.ok(fs.existsSync(pendingFile),
      'prod shape (tool_response as a direct array) must also extract banners');
    const content = fs.readFileSync(pendingFile, 'utf8');
    assert.match(content, /記憶搜尋/);
    assert.match(content, /技巧提示/);
  });

  // ─── Structural contract tests (v1.17.73 introduced a single case / v1.17.74 parameterized — deepen IR-007 mine clearance) ───
  // Clears the v1.17.71 → v1.17.72 mine where every fixture used the same wrong shape.
  // For the same input, feed both shapes and require extractBanners' result to match
  // (whether something is extracted or not).
  //
  // v1.17.73 covered only "kind + tip" dual banners. Reviewer pointed out (v1.17.74+ m-1):
  // broadcast / multi-part / empty parts / malformed parts were untested — path-specific bugs
  // on those branches still slipped through. v1.17.74 tabulates contract cases and runs the
  // same logic over 8 variants.
  const contractCases = [
    {
      name: 'single kind banner',
      parts: [{ type: 'text', text: '【OwnMind v1.17.71】記憶搜尋：A' }],
      expectBanner: true,
    },
    {
      name: 'dual banner (kind + tip)',
      parts: [{ type: 'text', text: '【OwnMind v1.17.71】記憶搜尋：A\n\n【OwnMind v1.17.71】技巧提示：B' }],
      expectBanner: true,
    },
    {
      name: 'broadcast banner (system notification)',
      parts: [{ type: 'text', text: '📢 OwnMind 系統通知\n[INFO] 升級到 v1.17.71\n---' }],
      expectBanner: true,
    },
    {
      name: 'broadcast + regular banner mixed',
      parts: [{ type: 'text', text: '📢 OwnMind 系統通知\n升級到 v1.17.74\n---\n\n【OwnMind v1.17.71】記憶搜尋：A' }],
      expectBanner: true,
    },
    {
      name: 'banner split across multiple content parts',
      parts: [
        { type: 'text', text: '【OwnMind v1.17.71】鐵律提醒：[IR-007]' },
        { type: 'text', text: '【OwnMind v1.17.71】技巧提示：鐵律不會被刪除' },
      ],
      expectBanner: true,
    },
    {
      name: 'empty parts array (no content)',
      parts: [],
      expectBanner: false,
    },
    {
      name: 'malformed part (type present, text missing)',
      parts: [{ type: 'text' }],
      expectBanner: false,
    },
    {
      name: 'plain text with no banner',
      parts: [{ type: 'text', text: 'No banner here, just plain data' }],
      expectBanner: false,
    },
  ];

  for (const c of contractCases) {
    it(`structural contract [${c.name}]: both shapes must behave identically`, () => {
      // (A) MCP shape
      runHook({ tool_response: mcpToolResponse(c.parts) }, { OWNMIND_TTY_FORCE_FALLBACK: '1' });
      const aHasFile = fs.existsSync(pendingFile);
      const aBlock = aHasFile
        ? JSON.parse(fs.readFileSync(pendingFile, 'utf8').trim().split('\n').pop()).block
        : null;
      if (aHasFile) fs.unlinkSync(pendingFile);  // conditional cleanup (m-6)

      // (B) legacy shape
      runHook({ tool_response: legacyToolResponse(c.parts) }, { OWNMIND_TTY_FORCE_FALLBACK: '1' });
      const bHasFile = fs.existsSync(pendingFile);
      const bBlock = bHasFile
        ? JSON.parse(fs.readFileSync(pendingFile, 'utf8').trim().split('\n').pop()).block
        : null;

      // Both shapes must agree on whether to write the pending file.
      assert.equal(aHasFile, bHasFile,
        `both shapes must agree on writing pending file ([${c.name}] mcp=${aHasFile} legacy=${bHasFile})`);

      if (c.expectBanner) {
        assert.ok(aHasFile, `[${c.name}] expected to extract a banner and write the pending file`);
        assert.equal(aBlock, bBlock,
          `[${c.name}] both shapes must produce the same block content (path-specific bugs caught immediately)`);
        assert.ok(aBlock && aBlock.length > 0, `[${c.name}] block must not be empty`);
      } else {
        assert.equal(aHasFile, false, `[${c.name}] must not extract a banner and must not write the pending file`);
      }
    });
  }

  it('malformed JSON input must not crash (defense in depth)', () => {
    const r = runHook('this is not json');
    assert.equal(r.status, 0, 'malformed JSON must still exit 0 and not block the tool flow');
  });

  it('exit code is always 0 (even when the hook itself errors)', () => {
    // Even if input is valid but writing fails (force fallback + cannot write file, simulating a full disk).
    const r = runHook({ tool_response: mcpToolResponse([{ type: 'text', text: '【OwnMind v1.17.71】X：Y' }]) },
      { OWNMIND_TTY_FORCE_FALLBACK: '1' });
    assert.equal(r.status, 0);
  });

  it('fallback path — banner-pending.jsonl uses JSON Lines format (one record per line)', () => {
    const input = {
      tool_response: mcpToolResponse([{ type: 'text', text: '【OwnMind v1.17.71】記憶搜尋：A' }]),
    };
    runHook(input, { OWNMIND_TTY_FORCE_FALLBACK: '1' });
    runHook(input, { OWNMIND_TTY_FORCE_FALLBACK: '1' });
    const content = fs.readFileSync(pendingFile, 'utf8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 2, 'two fallback runs should produce two JSON Lines rows');
    for (const line of lines) {
      const rec = JSON.parse(line);
      assert.ok(rec.ts, 'every record must include a ts timestamp');
      assert.ok(rec.block, 'every record must include a block payload');
    }
  });

  it('fallback must not write to stderr or stdout (so the AI never sees it)', () => {
    // Key point — Vin's spec #3: AI must not be able to filter or swallow the banner.
    // PostToolUse stderr → AI; stdout(plain text) → discarded.
    // Our fallback may only write to a file, never to stderr.
    const input = {
      tool_response: mcpToolResponse([{ type: 'text', text: '【OwnMind v1.17.71】記憶搜尋：A' }]),
    };
    const r = runHook(input, { OWNMIND_TTY_FORCE_FALLBACK: '1' });
    assert.equal(r.stderr, '', 'stderr must stay empty (AI channel is off-limits)');
    // stdout may be empty or the PostToolUse JSON, but must not contain banner text.
    assert.ok(!r.stdout.includes('【OwnMind v'),
      'stdout must not contain banner text (avoid Claude Code treating it as hook output)');
  });
});

describe('v1.26.171 — the tty channel is gone for good', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('the old tty override is ignored and the audit spool is always written', () => {
    // The primary path this block used to test opened /dev/tty — which a hook subprocess
    // can never do, so "primary" was a path that had never once run. The override env that
    // made it testable must now do nothing, and every emitted block lands in the spool.
    const fakeTty = path.join(tmpHome, 'fake-tty');
    fs.writeFileSync(fakeTty, '');
    const input = {
      tool_response: mcpToolResponse([{ type: 'text', text: '【OwnMind v1.17.71】記憶搜尋：A' }]),
    };
    const r = runHook(input, { OWNMIND_TTY_OVERRIDE: fakeTty });
    assert.equal(r.status, 0);
    assert.equal(fs.readFileSync(fakeTty, 'utf8'), '', 'nothing may write to a tty path anymore');
    assert.match(fs.readFileSync(pendingFile, 'utf8'), /記憶搜尋/, 'the audit spool records the block');
    assert.match(JSON.parse(r.stdout).systemMessage, /記憶搜尋/);
  });
});

// ============================================================
// v1.26.171 — the systemMessage contract (same port as ownmind-reply-lint.js)
//
// /dev/tty can never be opened from a hook subprocess (no controlling terminal, any
// platform), so the old primary path failed on every call it ever made, and the fallback
// spool stopped being read when the session-start flush was removed (it fed the spool into
// the model's context, not the user's eyes). The channel that renders for PostToolUse is
// the same one Stop uses: a single {"systemMessage": ...} JSON object on stdout at exit 0.
// The spool write stays, as the audit record.
// ============================================================

describe('v1.26.171 — banners ride systemMessage on stdout', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('a banner reaches stdout as exactly one systemMessage JSON object', () => {
    const input = {
      tool_name: 'mcp__ownmind__ownmind_search',
      tool_response: mcpToolResponse([
        { type: 'text', text: '[OwnMind v1.26.171] Memory search:\n{"data":[]}\n\n[OwnMind v1.26.171] Tip: search works' },
      ]),
    };
    const r = runHook(input);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '', 'stderr stays empty - it is not a user channel');
    const parsed = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(parsed), ['systemMessage'],
      'stdout must be exactly one systemMessage object - Claude Code parses it whole');
    assert.match(parsed.systemMessage, /Memory search/);
    assert.match(parsed.systemMessage, /Tip: search works/);
  });

  it('the spool records the same block as an audit trail', () => {
    const input = {
      tool_name: 'mcp__ownmind__ownmind_save',
      tool_response: mcpToolResponse([
        { type: 'text', text: '[OwnMind v1.26.171] Memory write: saved' },
      ]),
    };
    runHook(input);
    const content = fs.readFileSync(pendingFile, 'utf8');
    assert.match(content, /Memory write: saved/);
  });

  it('no banner means byte-for-byte silent stdout', () => {
    const input = {
      tool_name: 'Read',
      tool_response: mcpToolResponse([{ type: 'text', text: 'plain output, no banner' }]),
    };
    const r = runHook(input);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', 'a bannerless call must not render even an empty line');
  });
});
