#!/usr/bin/env node
'use strict';
// setup.js — trusted initialization for one gate session (prototype).
// In production this role belongs to the hook harness / OwnMind client, NOT
// to the assistant. Run:
//   node setup.js --state <dir> [--rules <file>] [--secrets <dir>]
// It creates:
//   <state>/                     assistant-writable session state dir
//   <secrets>/hmac.key           HMAC key, mode 0400, created once
//   <secrets>/nonce-<session>    fresh per-session nonce (regenerated each run)
//   <secrets>/rules.sha256       pinned hash of the rules file (re-pinned each
//                                run — re-running setup is the trusted way to
//                                accept a rule change)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const lib = require('./gatelib');

const args = lib.parseArgs(process.argv.slice(2));
if (!args.state) {
  console.error('usage: node setup.js --state <dir> [--rules <file>] [--secrets <dir>]');
  process.exit(1);
}

fs.mkdirSync(args.state, { recursive: true });
fs.mkdirSync(args.secrets, { recursive: true });

// Write a secret file with mode 0400; replace it if it already exists.
function writeSecret(name, value) {
  const p = path.join(args.secrets, name);
  try { fs.unlinkSync(p); } catch (e) { /* not there yet */ }
  fs.writeFileSync(p, value + '\n', { mode: 0o400 });
  return p;
}

// HMAC key: created once, shared by all sessions of this prototype.
const keyPath = path.join(args.secrets, 'hmac.key');
if (!fs.existsSync(keyPath)) {
  writeSecret('hmac.key', crypto.randomBytes(32).toString('hex'));
  console.log('created key   ' + keyPath + ' (mode 0400)');
} else {
  console.log('key exists    ' + keyPath);
}

// Fresh nonce for this session: receipts from any other session become
// unverifiable here by construction.
const session = lib.sessionId(args.state);
const noncePath = writeSecret('nonce-' + session, crypto.randomBytes(16).toString('hex'));
console.log('session nonce ' + noncePath);

// Pin the rules file bytes. gate.js fails closed if rules.json ever differs.
const rulesRaw = fs.readFileSync(args.rules);
const pinned = lib.sha256(rulesRaw);
writeSecret('rules.sha256', pinned);
console.log('pinned rules  ' + args.rules + ' sha256=' + pinned);
console.log('state dir     ' + path.resolve(args.state));
