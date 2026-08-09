#!/usr/bin/env node
// Command-line front end for register-mcp.cjs, so no caller has to embed JavaScript.
//
// v1.26.112 — this exists because `node -e "<script>"` does not survive PowerShell 5.1.
//
// The first version of the installer wiring passed the driver script to `node -e` from
// both shells. It worked from bash and failed from PowerShell, while `ParseFile` reported
// the script as syntactically perfect. Measured 2026-08-09 — a three-line probe printed:
//
//     NaN
//     NaN
//     NaN
//
// PowerShell 5.1 strips the double quotes when handing an argument to a native executable,
// so `console.log("argv1=" + process.argv[1])` reached node as
// `console.log(argv1=+process.argv[1])`: an assignment of unary-plus-undefined, which is
// NaN, printed three times. Nothing threw. The block simply reported that it could not
// register and moved on.
//
// This is the same family as v1.26.94, where `cygpath -w` output was interpolated into
// `node -e` source and JavaScript ate the backslashes. install.sh already carries the
// conclusion in a comment — "argv is the only shape that has no quoting layer to get
// wrong" — and then the MCP wiring went and added a quoting layer anyway.
//
// So: a real file on disk, arguments as argv, no embedded source in any shell.
//
// Not even JSON crosses the shell boundary. Passing the entry as a single JSON argument
// was the second attempt, and PowerShell stripped the quotes out of that too:
//
//     PROBLEM the MCP entry did not survive the shell:
//     Expected property name or '}' in JSON at position 1
//
// Which is the CLI doing its job — but the answer is to stop sending anything that
// contains a quote. Every value is now its own argv element, so the only characters that
// travel are the ones in a path or a URL.
//
// Usage:  node register-mcp-cli.cjs --command <cmd> [--arg <a>]... --url <u> --key <k>
//                                   --home <h> [--tool <t>]
//         node register-mcp-cli.cjs --upgrade <home>
// Prints: PROBLEM <text>   (zero or more)
//         VERIFIED | UNVERIFIED | ALREADY | NOCREDS | NOENTRY
// Exit:   0 always — the caller decides what to do about an unverified result, and an
//         installer must not abort a whole run over this one step.

const fs = require('fs');
const path = require('path');
const { registerMcp, isRegisteredForClaudeCode, readJson } = require('./register-mcp.cjs');

/**
 * The updater's path: repair a machine that was installed before v1.26.112.
 *
 * Kept here rather than inline in update.sh and update.ps1 so the two updaters cannot
 * drift, and so neither has to embed JavaScript — see the note at the top of this file.
 * Nothing is invented: the launch command and the credentials both come from what the
 * machine already has, so a machine with neither is left exactly as it was.
 */
function upgrade(home) {
  if (isRegisteredForClaudeCode({ home }).registered) return console.log('ALREADY');

  let creds;
  try {
    // `{ home }`, not the default: resolveCredentials would otherwise read os.homedir()
    // while registerMcp writes the home we were handed — one profile read, another
    // written, which is the very defect this release is about.
    ({ resolveCredentials: creds } = require('./resolve-credentials.cjs'));
  } catch (e) {
    console.log(`PROBLEM resolve-credentials.cjs unavailable: ${e.message}`);
    return console.log('UNVERIFIED');
  }
  const resolved = creds({ home });
  if (!resolved.apiKey || !resolved.apiUrl) return console.log('NOCREDS');

  // Reuse the entry already on the machine, so the launch command is not re-derived here
  // and cannot disagree with what the installer wrote.
  // readJson, not bare JSON.parse: it strips a BOM. PowerShell's `Set-Content -Encoding
  // utf8` writes UTF-8 **with** a BOM on 5.1, and `JSON.parse` throws on it — so a
  // settings.json touched by any PowerShell tool would land in the catch below, report
  // NOENTRY, and leave the machine unregistered with no explanation. Measured while
  // testing the upgrade path from PowerShell, 2026-08-09. install.ps1 has a
  // `Write-Utf8NoBom` helper precisely because this keeps happening.
  let entry = null;
  try {
    const s = readJson(path.join(home, '.claude', 'settings.json'));
    const prev = s.mcpServers && s.mcpServers.ownmind;
    if (prev && prev.command) entry = { command: prev.command, args: prev.args || [] };
  } catch (e) {
    // Say so rather than silently reporting NOENTRY: an unreadable settings.json and an
    // absent one need different fixes from the person reading this output.
    console.log(`PROBLEM could not read ~/.claude/settings.json: ${e.message}`);
  }
  if (!entry) return console.log('NOENTRY');

  const r = registerMcp({ entry, apiUrl: resolved.apiUrl, apiKey: resolved.apiKey, home });
  for (const p of r.problems) console.log(`PROBLEM ${p}`);
  return console.log(r.verified ? 'VERIFIED' : 'UNVERIFIED');
}

function main(argv) {
  if (argv[0] === '--upgrade') {
    const home = argv[1];
    if (!home) {
      console.log('PROBLEM --upgrade needs a home directory');
      return console.log('UNVERIFIED');
    }
    try {
      return upgrade(home);
    } catch (e) {
      console.log(`PROBLEM ${e.message}`);
      return console.log('UNVERIFIED');
    }
  }

  // Flags, so nothing that needs quoting ever travels. `--arg` repeats, in order.
  const opts = { arg: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = String(argv[i] || '').replace(/^--/, '');
    const value = argv[i + 1];
    if (!flag || value === undefined) {
      console.log(`PROBLEM malformed arguments near ${JSON.stringify(argv[i])}`);
      console.log('UNVERIFIED');
      return;
    }
    if (flag === 'arg') opts.arg.push(value);
    else opts[flag] = value;
  }

  const { url: apiUrl, key: apiKey, home, tool, command } = opts;
  if (!command || !apiUrl || !apiKey || !home) {
    console.log('PROBLEM register-mcp-cli needs --command --url --key --home');
    console.log('UNVERIFIED');
    return;
  }
  const entry = { command, args: opts.arg };

  let result;
  try {
    result = registerMcp({ entry, apiUrl, apiKey, home, tool: tool || 'claude-code' });
  } catch (e) {
    console.log(`PROBLEM ${e.message}`);
    console.log('UNVERIFIED');
    return;
  }

  for (const p of result.problems) console.log(`PROBLEM ${p}`);
  console.log(result.verified ? 'VERIFIED' : 'UNVERIFIED');
}

main(process.argv.slice(2));
