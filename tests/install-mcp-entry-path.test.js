import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * `cygpath -w` returns backslashes, and install.sh used to interpolate that straight into
 * the source text of `node -e`:
 *
 *     const p = 'C:\Users\Vin\.ownmind\mcp\start.cmd'.replace(/\\/g, '\\\\');
 *
 * `\U`, `\V`, `\.`, `\m`, `\s` are not escape sequences. JavaScript drops the backslash and
 * keeps the letter, so `p` was `C:UsersVin.ownmindmcpstart.cmd` before `.replace` ran — and
 * `.replace`, there to double the backslashes, had none left to double. Every bootstrap.sh
 * upgrade wrote that unusable command into ~/.claude/settings.json.
 *
 * Observed on Windows 10 + Git Bash: the 2026-08-05 file (written by install.ps1) held
 * `C:\\Users\\Vin\\.ownmind\\mcp\\start.cmd`; the copy taken right after an install.sh
 * upgrade held `C:UsersVin.ownmindmcpstart.cmd`.
 *
 * It stayed invisible because Claude Code launches the MCP server from ~/.claude.json,
 * which no installer writes.
 */

const SH = readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
const WIN_PATH = ['C:', 'Users', 'Vin', '.ownmind', 'mcp', 'start.cmd'].join(String.fromCharCode(92));

/** Pull one `MCP_ENTRY=$(node -e "..." "$VAR")` body out of install.sh and run it for real. */
function runMcpEntryBlock(afterMarker, pathArg) {
  const from = SH.indexOf(afterMarker);
  assert.ok(from > 0, `install.sh no longer contains ${afterMarker}`);
  const open = SH.indexOf('node -e "', from);
  const close = SH.indexOf('"', open + 'node -e "'.length);
  assert.ok(open > from && close > open, 'could not find the MCP_ENTRY node block');
  const script = SH.slice(open + 'node -e "'.length, close);
  return JSON.parse(execFileSync(process.execPath, ['-e', script, pathArg], { encoding: 'utf8' }));
}

describe('install.sh builds the MCP entry without destroying a Windows path', () => {
  it('the Windows branch keeps every backslash', () => {
    const entry = runMcpEntryBlock('START_CMD_WIN=', WIN_PATH);
    assert.equal(entry.command, 'cmd.exe');
    assert.deepEqual(entry.args, ['/c', WIN_PATH]);
  });

  it('the non-Windows branch round-trips its path too', () => {
    const entry = runMcpEntryBlock('MCP_ENTRY_PATH_WIN=', '/home/vin/.ownmind/mcp/index.js');
    assert.equal(entry.command, 'node');
    assert.deepEqual(entry.args, ['/home/vin/.ownmind/mcp/index.js']);
  });

  it('the path is never interpolated into the Node source again', () => {
    // The defect in one line: a shell variable holding a backslash path, sitting inside a
    // JavaScript string literal. Escaping cannot rescue it — the JS parser is what eats the
    // path — so the shape itself is what this forbids.
    const region = SH.slice(SH.indexOf('# --- 決定 MCP command / args'), SH.indexOf('# --- 2. Claude Code MCP'));
    const live = region.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
    assert.doesNotMatch(live, /'\$(START_CMD_WIN|MCP_ENTRY_PATH_WIN)'/,
      'a path variable is quoted into JS source again — pass it as argv instead');
    assert.match(live, /process\.argv\[1\]/, 'the path should arrive as argv');
  });

  it('reproduces what the old form did, so the fix is not mistaken for cosmetics', () => {
    // Exactly the source Node used to receive, with the path already substituted in.
    const BS = String.fromCharCode(92);
    const oldSource =
      `const p = '${WIN_PATH}'.replace(/${BS}${BS}/g, '${BS}${BS}${BS}${BS}');` +
      `console.log(JSON.stringify({ command: 'cmd.exe', args: ['/c', p] }));`;
    const broken = JSON.parse(execFileSync(process.execPath, ['-e', oldSource], { encoding: 'utf8' }));
    assert.equal(broken.args[1], 'C:UsersVin.ownmindmcpstart.cmd');
    assert.notEqual(broken.args[1], WIN_PATH);
  });
});
