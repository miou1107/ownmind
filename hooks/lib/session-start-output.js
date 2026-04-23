#!/usr/bin/env node
/**
 * hooks/lib/session-start-output.js — SessionStart hook 的 JSON 輸出包裝
 *
 * Usage: node session-start-output.js '<init JSON>' '<broadcasts JSON>'
 * Output: JSON to stdout matching Claude Code hookSpecificOutput schema
 *
 * 拆出來好處：render 邏輯（renderSessionContext）可以被 tests/session-start-render.test.js 直接 import
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
