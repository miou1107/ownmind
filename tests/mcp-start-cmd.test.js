import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const START_CMD = path.join(repoRoot, 'mcp/start.cmd');

/**
 * mcp/start.cmd must parse (v1.26.100)
 *
 * The launcher carried an unescaped pair of parentheses inside its `IF ... ( ... )` block:
 *
 *   echo Error logged to %ERRFILE% (next OwnMind self-check will upload). >&2
 *
 * cmd.exe parses the whole block in one pass before executing any of it, so the bare ")"
 * closed the block early, the parser met the "." that followed, and the script died with
 * ". was unexpected at this time." — before its first line ran. That is independent of
 * whether node was found, so it failed on every Windows machine and the OwnMind MCP server
 * never started. Symptom seen from the outside: no ownmind_* tools in any Claude Code
 * session on Windows, while memory still loaded (that goes through the Node SessionStart
 * hook, a different path), so nothing looked broken.
 *
 * Worse, the block it broke is the v1.17.79 error-spool block added *for observability*:
 * because the failure is at parse time, its own spool file was never written, so the
 * server could not learn that the MCP was dead.
 *
 * Two layers below: a static check that runs everywhere, and a real cmd.exe parse on
 * Windows. Introduced in v1.17.79 and undetected until 2026-08-08 because nothing here
 * ever fed the file to a parser.
 */

function readLines() {
  return fs.readFileSync(START_CMD, 'utf8').split(/\r?\n/);
}

/**
 * Strip the constructs that make a parenthesis harmless, so what is left is only the
 * parentheses cmd.exe will treat as block delimiters: escaped ^( ^) and quoted spans.
 */
function significantParens(line) {
  const stripped = line.replace(/\^\(|\^\)/g, '').replace(/"[^"]*"/g, '');
  return {
    opens: (stripped.match(/\(/g) || []).length,
    closes: (stripped.match(/\)/g) || []).length,
  };
}

describe('mcp/start.cmd — no unescaped parentheses inside a block', () => {
  it('every echo inside an open block escapes its parentheses', () => {
    let depth = 0;
    const offenders = [];

    readLines().forEach((line, idx) => {
      const { opens, closes } = significantParens(line);
      if (/^\s*echo\s/i.test(line) && depth > 0 && (opens > 0 || closes > 0)) {
        offenders.push(`line ${idx + 1}: ${line.trim()}`);
      }
      depth = Math.max(0, depth + opens - closes);
    });

    assert.deepEqual(
      offenders,
      [],
      `unescaped parentheses inside a cmd block kill the whole script at parse time; use ^( and ^):\n${offenders.join('\n')}`,
    );
  });

  it('blocks are balanced', () => {
    let depth = 0;
    for (const line of readLines()) {
      const { opens, closes } = significantParens(line);
      depth += opens - closes;
      assert.ok(depth >= 0, 'a block closes more times than it opens');
    }
    assert.equal(depth, 0, 'an IF block is left open');
  });

  it('still launches node on the last line', () => {
    const content = fs.readFileSync(START_CMD, 'utf8');
    assert.match(
      content,
      /"%NODE_EXE%"\s+"%~dp0index\.js"/,
      'the launcher must still start the MCP entry point',
    );
  });
});

describe('mcp/start.cmd — real cmd.exe parse', { skip: os.platform() !== 'win32' && 'Windows only' }, () => {
  it('cmd.exe parses the file without error', () => {
    // Replace only the final node launch with a marker: the point is to prove cmd.exe gets
    // through the file, not to start a server. The IF block above is still parsed either
    // way — which is exactly the failure mode being guarded.
    const lines = readLines();
    const launchIdx = lines.findIndex((l) => /"%NODE_EXE%"\s+"%~dp0index\.js"/.test(l));
    assert.ok(launchIdx >= 0, 'launch line not found');
    lines[launchIdx] = 'echo __PARSE_OK__';

    const probe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-cmd-')), 'probe.cmd');
    fs.writeFileSync(probe, lines.join('\r\n'), 'ascii');

    let out = '';
    try {
      out = execFileSync('cmd.exe', ['/c', probe], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      out = `${err.stdout || ''}${err.stderr || ''}`;
    }

    assert.match(
      out,
      /__PARSE_OK__/,
      `cmd.exe did not reach the end of start.cmd — it died while parsing:\n${out.trim()}`,
    );
  });
});
