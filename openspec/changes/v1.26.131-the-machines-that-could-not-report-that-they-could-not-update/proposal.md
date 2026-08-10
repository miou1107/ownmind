# v1.26.131 — Proposal: the machines that could not report that they could not update

## What was measured

Production, 2026-08-10. Nine users:

| | client version | activity events, 20 days |
|---|---|---|
| seven users | 1.26.125 – 1.26.128 | 41 – 5531 |
| Amiee | 1.26.57, frozen since 08-04 | **0** |
| Joanna | 1.26.27, frozen since 06-18 | **0** |

Both stale machines send an MCP heartbeat every single day, so their MCP process starts. They
are also the only two team members who do not use Claude Code — one uses Codex, one uses
Antigravity.

Zero events is not "few events". It means every `update_skipped`, `update_failed` and
`update_applied` this repo has emitted on those machines since v1.17.22 went nowhere. The two
users who most needed diagnosing were the two who could not be diagnosed.

## Why the heartbeat survives and nothing else does

`sendMcpHeartbeat()` is an immediate, unbuffered POST that touches no filesystem.

`logEvent()` did two things in one `try { } catch { }`, in this order:

```js
appendFileSync(filePath, JSON.stringify(entry) + '\n');   // local copy
buffer.push(entry);                                        // server copy
```

and `filePath` came from

```js
const LOGS_DIR = join(process.env.HOME || '', '.ownmind', 'logs');
```

**`HOME` is not set on Windows.** The empty-string fallback makes the path relative, so the
log directory resolved against whatever working directory the host launched the MCP in. Where
that is not writable, `ensureDir()` throws — and because the local write came *first*, the
throw jumped over `buffer.push`. The bare `catch {}` said nothing.

So one filesystem problem did not degrade an event to "sent but not stored". It deleted the
event, both copies, in silence.

This exact expression has already cost this project once. The comment above the auto-update
block in `mcp/index.js` records v1.17.22:

> root cause of Alice (Windows LAPTOP-G95HIQ3V) / Bob being stuck on old versions:
> `process.env.HOME` is undefined on Windows

`index.js` was moved to `os.homedir()` then. Its logger, one import away, was not — so the
machines that could not update also lost the ability to say so.

Claude Code users were unaffected twice over: their MCP starts in a writable project
directory, and their activity is also uploaded by the session hook's own `log_event`, which
uses a different path entirely. The defect was only ever visible on hosts without that hook.

## What changes

1. `resolveLogsDir()` — `HOME || USERPROFILE || os.homedir()`, the shape every other file in
   the repo already uses. Resolved per call so the Windows case is testable without a child
   process.
2. `logEvent` buffers **before** it writes, and the local write gets its own `try`. The two
   copies fail independently, and the one anybody can look at is no longer the one that dies.
3. `update_applied` / `update_failed` / `update_skipped` / `update_clean` join
   `IMMEDIATE_FLUSH_EVENTS`. They happen at most once a day, so batching buys nothing, and a
   host that terminates its MCP child rather than signalling it never runs the
   `beforeExit` / SIGTERM flush.

## On the third change, and on consulting Antigravity

Antigravity was asked directly about its own extension points. Two of its answers were worth
having and one was not:

- It independently recommended immediate-flush for the update events as its first choice, and
  its reasoning matched what the code shows. Kept.
- It described Antigravity's MCP servers as long-lived over stdio but terminated by a hard
  kill on Windows, so `SIGTERM`/`beforeExit` flushes cannot be relied on. Consistent with the
  evidence, and it is why (3) is not simply "flush on exit".
- It named `~/.gemini/config/hooks.json` and `.agents/hooks.json` as Antigravity hook
  configuration. **Neither exists on this machine**, and `~/.antigravity/` contains no hooks
  file. Not acted on.

## What this does not do

It does not give Codex or Antigravity a session-start updater. Those hosts have only the
MCP-startup path, while Claude Code, Gemini CLI and Cursor have two. That is a real gap and it
is Vin's call, not a defect fix — and it cannot be designed responsibly until the machines can
report which step their update actually fails at, which is what this release restores.

It does not retroactively recover the lost events. Nothing on those machines kept them.
