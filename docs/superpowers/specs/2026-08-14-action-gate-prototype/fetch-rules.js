#!/usr/bin/env node
'use strict';
// fetch-rules.js — the ONLY legitimate writer of read receipts.
//
//   node fetch-rules.js --state <dir> --rule <ruleId> [--rules][--secrets]
//
// Prints the rule's FULL text to stdout — this printout is the "read" — and
// writes <state>/receipt-<ruleId>.json containing an HMAC over
// (ruleId \n sha256(rule entry JSON) \n session nonce), computed with the key
// stored outside the assistant-writable state dir. gate.js gate 1 accepts a
// command only when this receipt verifies, so fetching (reading) the rule IS
// the unblock path.

const fs = require('fs');
const lib = require('./gatelib');

const args = lib.parseArgs(process.argv.slice(2));
if (!args.state || !args.rule) {
  console.error('usage: node fetch-rules.js --state <dir> --rule <ruleId> [--rules <file>] [--secrets <dir>]');
  process.exit(1);
}

let trust;
try {
  trust = lib.loadTrust(args.secrets, args.state);
} catch (e) {
  console.error('fetch-rules: session not initialized (run setup.js first): ' + e.message);
  process.exit(1);
}

const loaded = lib.loadRules(args.rules, trust.pinnedRulesHash);
if (loaded.error) {
  // Never hand out (or receipt) rule text from a tampered rules file.
  console.error('fetch-rules: ' + loaded.error);
  process.exit(1);
}

const rule = loaded.rules.find((r) => r.id === args.rule);
if (!rule) {
  console.error('fetch-rules: no rule with id "' + args.rule + '"');
  process.exit(1);
}

// The read: full rule text on stdout.
console.log('=== RULE ' + rule.id + ' — ' + rule.title + ' ===');
console.log(JSON.stringify(rule, null, 2));
console.log('=== END RULE ' + rule.id + ' ===');

const receipt = {
  ruleId: rule.id,
  ruleHash: lib.ruleHash(rule),
  fetchedAt: new Date().toISOString(),
  hmac: lib.computeReceiptHmac(trust.key, rule, trust.nonce),
};
fs.writeFileSync(lib.receiptPath(args.state, rule.id), JSON.stringify(receipt, null, 2) + '\n');
console.log('read receipt written: ' + lib.receiptPath(args.state, rule.id));
