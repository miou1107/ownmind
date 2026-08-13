'use strict';
// gatelib.js — shared helpers for the ACTION-TRACK enforcement gate prototype.
// Node stdlib only, no dependencies. Used by gate.js, fetch-rules.js, setup.js.
//
// Trust model (prototype):
//   - <secrets>/hmac.key       HMAC key. Lives OUTSIDE the assistant-writable
//                              state dir. In production this would be held by
//                              the hook harness / a root-owned file; in this
//                              single-user sandbox mode 0400 is symbolic only.
//   - <secrets>/nonce-<sess>   per-session nonce, written by setup.js.
//   - <secrets>/rules.sha256   pinned hash of rules.json, written by setup.js.
//                              gate.js fails CLOSED if rules.json no longer
//                              matches (anti rule-tampering).
//   - <state>/receipt-<id>.json read receipts, written ONLY by fetch-rules.js,
//                              HMAC over (ruleId \n ruleContentHash \n nonce).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = __dirname;
const DEFAULT_RULES = path.join(BASE, 'rules.json');
const DEFAULT_SECRETS = path.join(BASE, 'secrets');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--state') out.state = argv[++i];
    else if (a === '--rules') out.rules = argv[++i];
    else if (a === '--secrets') out.secrets = argv[++i];
    else if (a === '--rule') out.rule = argv[++i];
    else out._.push(a);
  }
  out.rules = out.rules || DEFAULT_RULES;
  out.secrets = out.secrets || DEFAULT_SECRETS;
  return out;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function hmacHex(keyHex, msg) {
  return crypto.createHmac('sha256', Buffer.from(keyHex, 'hex')).update(msg).digest('hex');
}

// Content hash of one rule entry. Both fetch-rules.js (writer) and gate.js
// (verifier) parse the same rules.json, so key order and therefore the
// serialization are identical on both sides.
function ruleHash(rule) {
  return sha256(JSON.stringify(rule));
}

function sessionId(stateDir) {
  return path.basename(path.resolve(stateDir));
}

function readSecret(secretsDir, name) {
  return fs.readFileSync(path.join(secretsDir, name), 'utf8').trim();
}

// Load all trust material. Throws if the session was never set up.
function loadTrust(secretsDir, stateDir) {
  return {
    key: readSecret(secretsDir, 'hmac.key'),
    nonce: readSecret(secretsDir, 'nonce-' + sessionId(stateDir)),
    pinnedRulesHash: readSecret(secretsDir, 'rules.sha256'),
  };
}

// Load rules.json and verify its bytes against the pinned hash. Any mismatch
// means the rules file was modified after setup — fail closed, do not judge
// with tampered rules.
function loadRules(rulesPath, pinnedRulesHash) {
  const raw = fs.readFileSync(rulesPath);
  const actual = sha256(raw);
  if (actual !== pinnedRulesHash) {
    return {
      error:
        'RULES-INTEGRITY-FAILURE: ' + path.basename(rulesPath) +
        ' sha256 ' + actual + ' does not match the hash pinned at setup (' + pinnedRulesHash + '). ' +
        'The rules file was modified outside setup. Failing closed.',
    };
  }
  return { rules: JSON.parse(raw.toString('utf8')) };
}

// Minimal shell lexer. Splits a command line into pipeline/list segments at
// unquoted  &  |  ;  and newlines, and normalizes each segment to its tokens
// joined by single spaces with quote characters removed. Trigger patterns are
// matched against these normalized segments and written anchored (^...), so
// `git grep "docker build"` does not read as a docker build, while
// `cd /app && docker build .` still does.
// Known limits (recorded in evidence.md): no backticks/$( ), no heredocs,
// no parameter expansion.
function lexSegments(cmd) {
  const segs = [];
  let tokens = [];
  let cur = '';
  let started = false;
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  const endToken = () => {
    if (started) { tokens.push(cur); cur = ''; started = false; }
  };
  const endSegment = () => {
    endToken();
    if (tokens.length) segs.push(tokens.join(' '));
    tokens = [];
  };
  while (i < cmd.length) {
    const ch = cmd[i];
    if (inSingle) {
      if (ch === "'") inSingle = false; else cur += ch;
      i++; continue;
    }
    if (ch === '\\' && i + 1 < cmd.length) { // escape: next char taken literally
      cur += cmd[i + 1]; started = true; i += 2; continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false; else cur += ch;
      i++; continue;
    }
    if (ch === "'") { inSingle = true; started = true; i++; continue; }
    if (ch === '"') { inDouble = true; started = true; i++; continue; }
    if (ch === '&' || ch === '|' || ch === ';' || ch === '\n') {
      endSegment();
      if ((ch === '&' || ch === '|') && cmd[i + 1] === ch) i++; // && and ||
      i++; continue;
    }
    if (ch === ' ' || ch === '\t') { endToken(); i++; continue; }
    cur += ch; started = true; i++;
  }
  endSegment();
  return segs;
}

function receiptPath(stateDir, ruleId) {
  return path.join(stateDir, 'receipt-' + ruleId + '.json');
}

function computeReceiptHmac(key, rule, nonce) {
  return hmacHex(key, rule.id + '\n' + ruleHash(rule) + '\n' + nonce);
}

// Gate 1 verification. The receipt is valid only if:
//   - it exists in THIS session's state dir and is a regular file (symlinks
//     rejected via lstat),
//   - its HMAC verifies against the CURRENT rule content hash and THIS
//     session's nonce, using the key the assistant does not hold.
// A hand-written receipt (no key), a receipt copied from another session
// (different nonce), and a receipt for since-modified rule text (different
// content hash) all fail the same HMAC check.
function verifyReceipt(stateDir, rule, trust) {
  const p = receiptPath(stateDir, rule.id);
  let st;
  try { st = fs.lstatSync(p); } catch (e) {
    return { ok: false, why: 'no read receipt for this session' };
  }
  if (st.isSymbolicLink()) return { ok: false, why: 'receipt is a symlink — rejected' };
  if (!st.isFile()) return { ok: false, why: 'receipt is not a regular file — rejected' };
  let rec;
  try { rec = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {
    return { ok: false, why: 'receipt is not valid JSON' };
  }
  const expected = Buffer.from(computeReceiptHmac(trust.key, rule, trust.nonce), 'hex');
  let got;
  try { got = Buffer.from(String(rec.hmac || ''), 'hex'); } catch (e) { got = Buffer.alloc(0); }
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
    return {
      ok: false,
      why: 'receipt failed HMAC verification (forged, from another session, or rule content changed since fetch)',
    };
  }
  return { ok: true };
}

function appendLog(stateDir, event) {
  try {
    fs.appendFileSync(path.join(stateDir, 'gate-log.jsonl'), JSON.stringify(event) + '\n');
  } catch (e) { /* logging must never turn a decision into a crash */ }
}

module.exports = {
  BASE, DEFAULT_RULES, DEFAULT_SECRETS,
  parseArgs, sha256, hmacHex, ruleHash, sessionId,
  loadTrust, loadRules, lexSegments,
  receiptPath, computeReceiptHmac, verifyReceipt, appendLog,
};
