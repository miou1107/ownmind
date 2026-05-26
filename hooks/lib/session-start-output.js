#!/usr/bin/env node
/**
 * hooks/lib/session-start-output.js — JSON output wrapper for the SessionStart hook.
 *
 * Usage: node session-start-output.js '<init JSON>' '<broadcasts JSON>'
 * Output: JSON to stdout matching the Claude Code hookSpecificOutput schema.
 *
 * Why extract this: the render logic (renderSessionContext) can be imported directly by
 * tests/session-start-render.test.js.
 */

import { renderSessionContext } from './render-session-context.js';

let initData = {};
let broadcasts = [];
try { initData = JSON.parse(process.argv[2] || '{}'); } catch {}
try { broadcasts = JSON.parse(process.argv[3] || '[]'); } catch {}

const additionalContext = renderSessionContext(initData, broadcasts);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext
  }
}));
