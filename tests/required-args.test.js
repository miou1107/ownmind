import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  findMissingArgs,
  buildMissingArgsError,
  ARG_ALIASES,
  GUARD_EXEMPT_FIELDS,
} from '../mcp/lib/required-args.js';

/**
 * v1.26.27 — client-side required-argument guard for ownmind_* MCP tools.
 *
 * Two AIs filed near-identical "I sent the fields but the server says they're
 * missing" reports (ownmind_save, then ownmind_log_session). In both the server
 * received only a subset of the arguments (e.g. just `summary` + the
 * client-injected `sync_token`), so requireFields() returned 400 "必填欄位缺少".
 * Root cause was the caller delivering an arguments object that lacked the
 * required keys — not OwnMind eating them. A server round-trip turned a
 * caller-side mistake into a confusing 400.
 *
 * This guard mirrors src/utils/require-fields.js "missing" semantics on the
 * client so an incomplete call fails fast with an actionable, self-diagnosing
 * error BEFORE any network round-trip.
 */

describe('findMissingArgs — mirrors server require-fields "missing" semantics', () => {
  it('all required present → no missing (the happy path)', () => {
    const missing = findMissingArgs(
      'ownmind_log_session',
      { summary: 's', tool: 'claude-code', model: 'claude-opus-4-8' },
      ['summary', 'tool', 'model'],
    );
    assert.deepEqual(missing, []);
  });

  it('the actual bug: log_session with only summary → tool, model missing', () => {
    const missing = findMissingArgs(
      'ownmind_log_session',
      { summary: 's' },
      ['summary', 'tool', 'model'],
    );
    assert.deepEqual(missing, ['tool', 'model']);
  });

  it('undefined value counts as missing', () => {
    const missing = findMissingArgs('t', { a: undefined }, ['a']);
    assert.deepEqual(missing, ['a']);
  });

  it('null value counts as missing', () => {
    const missing = findMissingArgs('t', { a: null }, ['a']);
    assert.deepEqual(missing, ['a']);
  });

  it('empty string counts as missing', () => {
    const missing = findMissingArgs('t', { a: '' }, ['a']);
    assert.deepEqual(missing, ['a']);
  });

  it('empty array counts as missing', () => {
    const missing = findMissingArgs('t', { a: [] }, ['a']);
    assert.deepEqual(missing, ['a']);
  });

  it('whitespace-only string is NOT missing (matches server: only "" is missing)', () => {
    const missing = findMissingArgs('t', { a: '  ' }, ['a']);
    assert.deepEqual(missing, []);
  });

  it('non-object args is treated as empty → all required missing', () => {
    assert.deepEqual(findMissingArgs('t', undefined, ['a', 'b']), ['a', 'b']);
    assert.deepEqual(findMissingArgs('t', null, ['a']), ['a']);
  });

  it('no required fields → never missing', () => {
    assert.deepEqual(findMissingArgs('t', {}, []), []);
    assert.deepEqual(findMissingArgs('t', {}, undefined), []);
  });
});

describe('findMissingArgs — alias handling for secret tools', () => {
  it('get_secret accepts `name` as an alias for `key` → not missing', () => {
    const missing = findMissingArgs(
      'ownmind_get_secret',
      { name: 'GITLAB_PAT' },
      ['key'],
    );
    assert.deepEqual(missing, []);
  });

  it('get_secret with neither key nor name → key missing', () => {
    const missing = findMissingArgs('ownmind_get_secret', {}, ['key']);
    assert.deepEqual(missing, ['key']);
  });

  it('set_secret: name alias satisfies key, value still required', () => {
    const missing = findMissingArgs(
      'ownmind_set_secret',
      { name: 'K' },
      ['key', 'value'],
    );
    assert.deepEqual(missing, ['value']);
  });

  it('ARG_ALIASES is exported and maps the three secret tools', () => {
    assert.ok(ARG_ALIASES.ownmind_get_secret.key.includes('name'));
    assert.ok(ARG_ALIASES.ownmind_set_secret.key.includes('name'));
    assert.ok(ARG_ALIASES.ownmind_delete_secret.key.includes('name'));
  });
});

describe('findMissingArgs — guard-exempt fields (human-in-the-loop gates)', () => {
  // ownmind_report_bug's confirm_string is a deliberate human confirmation gate:
  // the AI MUST NOT auto-fill it, and the server verifies the exact submit phrase.
  // The client guard must NOT report it as a "just add it" missing field, or it
  // would nudge a misbehaving AI to invent the value and defeat the safety design.
  it('report_bug: missing confirm_string is NOT reported (exempt)', () => {
    const missing = findMissingArgs(
      'ownmind_report_bug',
      { title: 't', description: 'd', bug_fingerprint: 'clt_user_reported_other' },
      ['title', 'description', 'bug_fingerprint', 'confirm_string'],
    );
    assert.deepEqual(missing, []);
  });

  it('report_bug: a genuine missing data field is still caught', () => {
    const missing = findMissingArgs(
      'ownmind_report_bug',
      { description: 'd', confirm_string: '送出' },
      ['title', 'description', 'bug_fingerprint', 'confirm_string'],
    );
    assert.deepEqual(missing, ['title', 'bug_fingerprint']);
  });

  it('GUARD_EXEMPT_FIELDS exposes confirm_string for report_bug', () => {
    assert.ok(GUARD_EXEMPT_FIELDS.ownmind_report_bug.includes('confirm_string'));
  });
});

describe('buildMissingArgsError — actionable, leak-free message', () => {
  it('names the tool, the missing fields, and the received keys', () => {
    const msg = buildMissingArgsError(
      'ownmind_log_session',
      ['tool', 'model'],
      { summary: 's', sync_token: 'abc' },
    );
    assert.match(msg, /ownmind_log_session/);
    assert.match(msg, /tool/);
    assert.match(msg, /model/);
    // surfaces which keys actually arrived, so the AI can see the gap
    assert.match(msg, /summary/);
    assert.match(msg, /sync_token/);
  });

  it('empty arguments object → explains it as a caller/transport issue', () => {
    const msg = buildMissingArgsError('ownmind_log_session', ['summary', 'tool', 'model'], {});
    assert.match(msg, /no arguments|empty/i);
  });

  it('never leaks argument VALUES — only key names appear', () => {
    const msg = buildMissingArgsError(
      'ownmind_set_secret',
      ['value'],
      { key: 'GITLAB_PAT', value: '' },
    );
    // 'value' appears as a field name (it's missing), but the secret content must never appear.
    assert.ok(!msg.includes('GITLAB_PAT'), `message leaked a value: ${msg}`);
  });

  it('handles non-object args without throwing', () => {
    const msg = buildMissingArgsError('t', ['a'], undefined);
    assert.match(msg, /a/);
  });
});
