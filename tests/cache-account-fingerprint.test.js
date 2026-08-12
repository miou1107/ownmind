// v1.26.82 — the memory cache does not record whose account it belongs to.
//
// Adam once installed somebody else's API key. Vin asked whether anything was left behind.
// On the server, nothing: his machine has only ever reported under his own account since
// telemetry began. On his disk, two things — and one of them is read by his AI on every
// session whether or not OwnMind is working:
//
//   ~/.claude/skills/ownmind-iron-rules/   iron rules, written as a Claude Code skill
//   ~/.ownmind/cache/memories.json         the whole init payload, profile included
//
// The cache is written with `sync_token` and `saved_at` and nothing that says who it is
// for. Change credentials and the previous account's memories stay, get read, and are
// invisible: `sync_token` from the old account will not match the new server response, so
// it does refresh eventually — but only if a sync runs at all, and on a machine whose hook
// never fires, nothing ever runs.
//
// The scanner already solved this. v1.26.69 added an account fingerprint to its cursor file
// after exactly this hazard: "a machine that changed credentials handed the new account the
// previous one's already-reported state". The memory cache never got the same treatment.
//
// The fingerprint is a hash of server + key, so it identifies an account without storing
// the key.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accountFingerprint } from '../shared/scanners/base.js';
import { readCache, writeCache, shouldRefreshCache } from '../hooks/lib/conditional-sync.js';
import { tempDir } from './helpers/temp-dir.js';

const ACC_A = { apiUrl: 'https://kkvin.com/ownmind', apiKey: 'a'.repeat(36) };
const ACC_B = { apiUrl: 'https://kkvin.com/ownmind', apiKey: 'b'.repeat(36) };

const tmpCache = () => path.join(tempDir('ownmind-cache-'), 'memories.json');

describe('the memory cache records which account it belongs to', () => {
  it('writes the fingerprint alongside the payload', () => {
    const p = tmpCache();
    writeCache({ sync_token: 't1', data: { profile: { title: 'A' } } }, p, fs, ACC_A);
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(raw.account, accountFingerprint(ACC_A));
  });

  it('never writes the key itself', () => {
    const p = tmpCache();
    writeCache({ sync_token: 't1', data: {} }, p, fs, ACC_A);
    const raw = fs.readFileSync(p, 'utf8');
    assert.ok(!raw.includes(ACC_A.apiKey), 'the cache would become a place to read a key from');
  });

  it('refuses a cache written for a different account', () => {
    // Adam's case. Someone else's profile and iron rules, still on disk, still being read.
    const p = tmpCache();
    writeCache({ sync_token: 't1', data: { profile: { title: 'somebody else' } } }, p, fs, ACC_A);
    assert.equal(readCache(p, fs, ACC_B), null, 'another account\'s memories were handed over');
  });

  it('returns the cache to the account that wrote it', () => {
    const p = tmpCache();
    writeCache({ sync_token: 't1', data: { profile: { title: 'mine' } } }, p, fs, ACC_A);
    const c = readCache(p, fs, ACC_A);
    assert.equal(c?.sync_token, 't1');
    assert.equal(c?.data?.profile?.title, 'mine');
  });

  it('treats a cache written before this version as unknown, not as mine', () => {
    // Every existing machine has one of these. Claiming it belongs to whoever asks is the
    // bug; discarding it costs one extra download, once.
    const p = tmpCache();
    fs.writeFileSync(p, JSON.stringify({ sync_token: 't1', saved_at: new Date().toISOString(), data: {} }));
    assert.equal(readCache(p, fs, ACC_A), null);
  });

  it('still works when no account is supplied, for callers that have none', () => {
    const p = tmpCache();
    writeCache({ sync_token: 't1', data: { x: 1 } }, p, fs, ACC_A);
    const c = readCache(p, fs);
    assert.equal(c?.sync_token, 't1', 'omitting the account must not break existing callers');
  });

  it('a rejected cache leads to a full refresh rather than a stale hit', () => {
    // readCache returning null has to actually mean "download everything again".
    assert.equal(shouldRefreshCache(null, 'whatever'), true);
  });
});
