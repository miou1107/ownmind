// Launch the registered MCP server the way Claude Code would, and ask it for its tools.
//
// v1.26.117 — the check `mcp_registered` could not be. That one reads `~/.claude.json` and
// confirms an `mcpServers.ownmind` entry exists, which is what v1.26.112 needed: on that
// machine the key was absent entirely. What it cannot see is the entry that is present and
// does not start, and this repository has produced that failure four separate times:
//
//   - v1.26.94  — a `cygpath -w` path was interpolated into `node -e` source; the JS parser
//                 ate the backslashes. The config looked perfect, the command was broken.
//   - v1.26.112 — PowerShell 5.1 strips double quotes from arguments passed to a native
//                 executable, so the `node -e` script became meaningless code — while
//                 PowerShell's own parser pronounced it flawless.
//   - v1.26.112 — Git Bash rewrites `cmd.exe`'s `/c` as a POSIX path (`C:/`), and that
//                 rewritten form can be what gets written into the launch command.
//   - v1.17.77 / v1.17.79 — `start.cmd` carries a whole fallback ladder for the case where
//                 node is not on PATH, whose failure is a file in the error spool, not a
//                 wrong entry in `~/.claude.json`.
//
// Every one of those leaves a registration that reads correctly. "Registered" and "starts"
// are separated by a lot of machinery, and until now nothing looked at any of it.
//
// So this helper does what Claude Code does at the start of a session: take the `command`,
// `args` and `env` **exactly as written in that file**, spawn it, complete the JSON-RPC
// handshake, and ask `tools/list` for the `ownmind_*` tools. Reconstructing the command from
// what the installer intended would test the intention; the entry on disk is the thing that
// has been wrong four times.
//
// ## This check fails open, on purpose
//
// It starts a real server, which costs a couple of seconds of node start-up. The risk is not
// the delay, it is the **false accusation**: a loaded machine or a cold node can exceed any
// budget while being perfectly healthy, and self-check runs at the end of an install or an
// upgrade — the busiest moment there is. v1.26.106 already shipped exactly that bug in the
// scheduler check, uploading a fabricated FAIL for a task that was Ready.
//
// A timeout here therefore means **cannot tell**, never **broken**. That is the opposite of
// `lock_age_seconds` (v1.26.113), which must fail closed, and the difference is what the
// answer is for: that one gates an *action* — seizing a lock on a bad reading corrupts
// something. This one is a *diagnosis*, and a diagnosis that guesses wrong accuses a machine
// that is fine. Diagnostics should say "unknown"; behaviour should assume the worst.
//
// Splitting the responsibility in two keeps the cheap certainty: `mcp_registered` stays a
// pure file read that always has an answer, and this one adds the part that can be
// indeterminate without ever weakening the first.

'use strict';

const { spawn } = require('child_process');
const os = require('os');
const { readJson, CLAUDE_JSON } = require('./register-mcp.cjs');
const { resolveSystemBinary } = require('./win-system-binary.cjs');

// Cold node on Windows, spawned through cmd.exe, measured at 2-6s. 20s is deliberate slack:
// the cost of being generous is a slow check, the cost of being tight is the fabricated
// failure described above. See CIM_TIMEOUT_MS in self-check.cjs for the same trade made for
// the same reason.
const DEFAULT_TIMEOUT_MS = 20000;
// What the client asks for. The server answers with the version it actually speaks, and that
// is what gets reported — an older or newer server is not this check's business, whether the
// process starts and exposes tools is.
const PROTOCOL_VERSION = '2024-11-05';
const TOOL_PREFIX = 'ownmind_';
const STDERR_TAIL_BYTES = 500;
// Every env var whose *value* must never appear in a result, however it got there.
const SECRET_KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

/**
 * Redact before anything is returned, not at the print site.
 *
 * The result of this helper goes into the self-check report, which is written to a log file
 * and uploaded to the server. The env handed to the child contains `OWNMIND_API_KEY`, and a
 * failing child is precisely the case where its stderr is quoted back — a server that dies
 * complaining about its credentials would otherwise publish them. One redactor, applied to
 * every string that leaves this module, is the only version of this that stays true after
 * somebody adds a field.
 */
function makeRedactor({ home, env }) {
  const secrets = [];
  for (const [k, v] of Object.entries(env || {})) {
    // Short values are skipped: replacing every occurrence of a two-character "secret" would
    // shred the surrounding text and tell the reader nothing.
    if (SECRET_KEY_RE.test(k) && typeof v === 'string' && v.length >= 8) secrets.push(v);
  }
  return function redact(s) {
    let out = typeof s === 'string' ? s : String(s ?? '');
    for (const v of secrets) out = out.split(v).join('***');
    if (home) out = out.split(home).join('~');
    return out;
  };
}

function describeCommand(entry, redact) {
  return redact([entry.command, ...(entry.args || [])].join(' '));
}

/**
 * The registration as Claude Code would read it.
 *
 * `home` is an explicit argument with no clever default beyond `os.homedir()`, for the reason
 * v1.26.112 learned twice: on Windows `os.homedir()` is `USERPROFILE`, which is not
 * necessarily the `$HOME` a bash-side caller means. A caller that knows which home it is
 * asking about must be able to say so.
 */
function readRegistration({ home = os.homedir() } = {}) {
  const path = require('path');
  const file = path.join(home, CLAUDE_JSON);
  let config;
  try {
    config = readJson(file);
  } catch (e) {
    return { error: `~/${CLAUDE_JSON} is unreadable (${e.message})` };
  }
  const entry = config.mcpServers && config.mcpServers.ownmind;
  if (!entry) return { error: `no mcpServers.ownmind in ~/${CLAUDE_JSON}` };
  if (!entry.command) return { error: `mcpServers.ownmind in ~/${CLAUDE_JSON} has no command` };
  return { entry };
}

function jsonRpc(obj) {
  return JSON.stringify(obj) + '\n';
}

/**
 * Best-effort teardown.
 *
 * On Windows the registered command is `cmd.exe /c start.cmd`, so the process this module
 * holds is the shell, and killing it leaves the node server it launched running. A self-check
 * that leaks a server process every run is worse than the check is worth, hence the tree
 * kill. It is best-effort by nature — the pid may already be gone, which taskkill reports as
 * an error and which is the outcome we wanted anyway.
 */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill(); } catch { /* already gone */ }
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn(resolveSystemBinary('taskkill'), ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      }).on('error', () => { /* taskkill absent or pid already reaped */ });
    } catch { /* spawn refused; the direct kill above is what we have */ }
  }
}

/**
 * Start the registered server and ask it for its tools.
 *
 * Returns (never throws, never rejects):
 *   { status: 'ok' | 'fail' | 'unknown', reason, command, env_keys, phase, elapsed_ms,
 *     server_name?, server_version?, protocol_version?, tool_count?, ownmind_tool_count?,
 *     exit_code?, stderr_tail? }
 *
 * `status` is deliberately not a boolean. "Cannot tell" is a real answer here and collapsing
 * it into either of the other two is the mistake this whole file is about.
 */
function preflightMcp(options = {}) {
  const {
    home = os.homedir(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    entry: givenEntry = null,
    spawnFn = spawn,
    // Injected only by tests. The fix below is Windows-only and this file is edited on a
    // Mac, so without a way to state the platform the assertion that proves it passes
    // vacuously everywhere it is actually run.
    resolveDeps = {},
  } = options;

  let entry = givenEntry;
  if (!entry) {
    const r = readRegistration({ home });
    if (r.error) {
      // Not a `fail`. There is nothing to launch, so the launch question has no answer —
      // and the actual fault, being unregistered, is `mcp_registered`'s to report. Two
      // failures for one cause is how a report stops being read.
      return Promise.resolve({
        status: 'unknown',
        reason: `${r.error} — nothing to launch (mcp_registered reports this)`,
        phase: 'registration',
      });
    }
    entry = r.entry;
  }

  // OWNMIND_PREFLIGHT marks this start as a diagnostic. The server sends a heartbeat when it
  // starts, and collector-silence reads that heartbeat to decide whether a machine has gone
  // quiet — so a check that runs daily and unattended would keep vouching for a machine
  // nobody is using. Set last, after the entry's own env, so a registration cannot switch it
  // off by accident.
  const env = { ...process.env, ...(entry.env || {}), OWNMIND_PREFLIGHT: '1' };
  const redact = makeRedactor({ home, env });
  const base = {
    command: describeCommand(entry, redact),
    // Names only. The values are the credentials; the names are what tells a reader whether
    // the entry is complete.
    env_keys: Object.keys(entry.env || {}),
  };
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    // Where we got to before it went wrong. On a timeout this is the entire diagnosis:
    // "spawned but never answered initialize" and "initialized but never answered
    // tools/list" call for completely different next steps.
    let phase = 'spawn';
    let stdoutBuf = '';
    let stderrBuf = '';
    let serverInfo = null;
    let protocolVersion = null;
    let child = null;
    let timer = null;

    const finish = (status, reason, extra = {}) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      killTree(child);
      resolve({
        status,
        reason: redact(reason),
        phase,
        elapsed_ms: Date.now() - startedAt,
        ...base,
        ...extra,
      });
    };

    const stderrTail = () => redact(stderrBuf).trim().slice(-STDERR_TAIL_BYTES);

    try {
      // v1.30.10 — `cmd.exe` is what the Windows installer registers, and one machine could
      // not spawn it: `could not spawn: spawn cmd.exe ENOENT`, from a self-check whose PATH
      // had lost System32 (see win-system-binary.cjs). Claude Code launches this same entry
      // from the desktop session, where PATH is usually intact — so the check was reporting
      // its own environment as the machine's. Resolving to the address Windows guarantees
      // asks the question the check is actually for: does this entry produce a server.
      child = spawnFn(resolveSystemBinary(entry.command, resolveDeps), entry.args || [], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // Never a shell: the registered command is already whatever the installer decided,
        // and re-parsing it through cmd.exe would be a second chance to mangle it (the
        // hazard safe-spawn.cjs exists for).
        shell: false,
      });
    } catch (e) {
      return finish('fail', `could not spawn: ${e.message}`);
    }

    child.on('error', (e) => {
      // ENOENT here means the registered command does not exist on this machine — the
      // "registered but cannot start" case in its purest form.
      finish('fail', `could not spawn: ${e.message}`, { stderr_tail: stderrTail() });
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      finish('fail',
        `server exited before answering (code=${code}${signal ? ` signal=${signal}` : ''})`,
        { exit_code: code, stderr_tail: stderrTail() });
    });

    child.stderr.on('data', (d) => {
      stderrBuf += String(d);
      // Bounded: a chatty server must not be able to grow this without limit for the whole
      // timeout window. Keep the tail — the last thing it said before dying is the useful end.
      if (stderrBuf.length > STDERR_TAIL_BYTES * 8) {
        stderrBuf = stderrBuf.slice(-STDERR_TAIL_BYTES * 8);
      }
    });

    child.stdout.on('data', (d) => {
      stdoutBuf += String(d);
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          // Not our business to police: a line of log noise on stdout would break a real
          // client too, but it is not evidence that the server is down, and this check
          // answers one question only.
          continue;
        }
        handle(msg);
      }
    });

    function handle(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.id === 1) {
        if (msg.error) {
          return finish('fail', `initialize returned an error: ${msg.error.message || JSON.stringify(msg.error)}`);
        }
        const res = msg.result || {};
        serverInfo = res.serverInfo || null;
        protocolVersion = res.protocolVersion || null;
        phase = 'initialized';
        // The SDK server rejects requests that arrive before this notification, so the
        // handshake is three messages, not two. Leaving it out produces a server that
        // answered `initialize` and then appears to hang — which this check would report as
        // "unknown", blaming the machine for the client's mistake.
        write(jsonRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }));
        write(jsonRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
        return;
      }
      if (msg.id === 2) {
        if (msg.error) {
          return finish('fail', `tools/list returned an error: ${msg.error.message || JSON.stringify(msg.error)}`);
        }
        const tools = (msg.result && msg.result.tools) || [];
        const names = tools.map((t) => (t && t.name) || '').filter(Boolean);
        const ownmind = names.filter((n) => n.startsWith(TOOL_PREFIX));
        const detail = {
          server_name: serverInfo && serverInfo.name,
          server_version: serverInfo && serverInfo.version,
          protocol_version: protocolVersion,
          tool_count: names.length,
          ownmind_tool_count: ownmind.length,
        };
        phase = 'tools';
        if (ownmind.length === 0) {
          // Starting is not the goal; being the OwnMind server is. A registration pointing at
          // some other MCP server starts perfectly and leaves the user with no ownmind_* tool,
          // which is the same symptom v1.26.112 was about.
          return finish('fail',
            `server started but exposes no ${TOOL_PREFIX}* tools (${names.length} tools total)`,
            detail);
        }
        return finish('ok',
          `handshake ok, ${ownmind.length}/${names.length} tools are ${TOOL_PREFIX}*`
          + `${serverInfo ? ` (${serverInfo.name} v${serverInfo.version})` : ''}`,
          detail);
      }
    }

    function write(s) {
      try {
        child.stdin.write(s);
      } catch (e) {
        finish('fail', `could not write to the server's stdin: ${e.message}`,
          { stderr_tail: stderrTail() });
      }
    }

    // EPIPE when the child is already gone; the exit handler owns that story.
    child.stdin.on('error', () => {});

    timer = setTimeout(() => {
      finish('unknown',
        `no answer within ${timeoutMs}ms (reached: ${phase}) — a busy or cold machine can `
        + 'exceed this while being healthy, so this is not a failure',
        { stderr_tail: stderrTail() });
    }, timeoutMs);

    write(jsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'ownmind-self-check', version: '1' },
      },
    }));
  });
}

module.exports = {
  preflightMcp,
  readRegistration,
  makeRedactor,
  DEFAULT_TIMEOUT_MS,
  TOOL_PREFIX,
};

// Standalone: `node mcp-preflight.cjs [--home=...] [--timeout=ms]`, prints the result as
// JSON. The same redaction applies, so its output is safe to paste into a bug report.
if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const timeout = Number(get('timeout'));
  preflightMcp({
    home: get('home') || os.homedir(),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  }).then((r) => {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    // Exit 0 whatever the verdict: this is a diagnostic, and callers read the JSON.
    process.exit(0);
  });
}
