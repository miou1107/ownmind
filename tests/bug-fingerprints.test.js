import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUG_FINGERPRINT_REGISTRY,
  getFingerprintMetadata,
  isValidFingerprint,
  fingerprintsByPrefix,
} from '../shared/bug-fingerprints.js';

// ============================================================
// The registry is a code-level enumeration; new fingerprints must be registered before use.
// ============================================================

test('registry is an object and not empty', () => {
  assert.equal(typeof BUG_FINGERPRINT_REGISTRY, 'object');
  assert.ok(Object.keys(BUG_FINGERPRINT_REGISTRY).length > 0);
});

test('every fingerprint has both category and description fields', () => {
  for (const [key, meta] of Object.entries(BUG_FINGERPRINT_REGISTRY)) {
    assert.ok(meta.category, `${key} is missing category`);
    assert.ok(meta.description, `${key} is missing description`);
  }
});

test('fingerprint name format: <prefix>_<context>; prefix must be a recognized category', () => {
  const validPrefixes = ['mem', 'srv_err', 'clt', 'lint', 'sync', 'auth'];
  for (const key of Object.keys(BUG_FINGERPRINT_REGISTRY)) {
    const prefix = key.startsWith('srv_err_') ? 'srv_err' : key.split('_')[0];
    assert.ok(
      validPrefixes.includes(prefix),
      `${key} prefix ${prefix} is not in the valid list`
    );
  }
});

test('fingerprint names only contain lowercase a-z / digits / underscore, no timestamps or ids', () => {
  for (const key of Object.keys(BUG_FINGERPRINT_REGISTRY)) {
    assert.match(key, /^[a-z0-9_]+$/, `${key} contains invalid characters`);
    assert.doesNotMatch(key, /\d{8,}/, `${key} looks like it contains a timestamp`);
  }
});

// ============================================================
// Query API
// ============================================================

test('getFingerprintMetadata returns the registry entry', () => {
  const meta = getFingerprintMetadata('mem_blocked_secret_keyword');
  assert.ok(meta);
  assert.equal(meta.category, 'mem');
});

test('getFingerprintMetadata returns null for unregistered fingerprints', () => {
  assert.equal(getFingerprintMetadata('not_registered_xxx'), null);
  assert.equal(getFingerprintMetadata(''), null);
  assert.equal(getFingerprintMetadata(null), null);
  assert.equal(getFingerprintMetadata(undefined), null);
});

test('isValidFingerprint returns true for registered fingerprints', () => {
  assert.equal(isValidFingerprint('mem_blocked_secret_keyword'), true);
});

test('isValidFingerprint returns false for unregistered fingerprints', () => {
  assert.equal(isValidFingerprint('not_registered_xxx'), false);
  assert.equal(isValidFingerprint(''), false);
  assert.equal(isValidFingerprint(null), false);
});

test('fingerprintsByPrefix returns every fingerprint under the category', () => {
  const memFps = fingerprintsByPrefix('mem');
  assert.ok(Array.isArray(memFps));
  assert.ok(memFps.length > 0);
  for (const fp of memFps) {
    assert.ok(fp.startsWith('mem_'), `${fp} should start with mem_`);
  }
});

test('fingerprintsByPrefix returns empty array for unknown category', () => {
  assert.deepEqual(fingerprintsByPrefix('xxxxx'), []);
});

// ============================================================
// Fingerprints required for phase 1 (mapped to spec.md scenarios)
// ============================================================

test('contains mem_blocked_secret_keyword referenced in spec.md scenarios', () => {
  assert.ok(isValidFingerprint('mem_blocked_secret_keyword'));
});

test('contains a generic 5xx backend error (used by the global 5xx handler)', () => {
  // At least one srv_err_ prefix fingerprint is required.
  const srvErrors = Object.keys(BUG_FINGERPRINT_REGISTRY).filter(k => k.startsWith('srv_err_'));
  assert.ok(srvErrors.length > 0, 'need at least one srv_err_ fingerprint for the 5xx handler');
});

// v1.26.1: free-form escape hatch fingerprint must be registered.
test('v1.26.1: clt_user_reported_other is registered as the free-form escape hatch', () => {
  assert.equal(isValidFingerprint('clt_user_reported_other'), true);
  const meta = getFingerprintMetadata('clt_user_reported_other');
  assert.ok(meta);
  assert.equal(meta.category, 'clt');
  assert.match(meta.description, /free-form|user-initiated|design issue/i);
});

// ============================================================
// Stability: fingerprints are constants and must not contain dynamic values.
// ============================================================

test('fingerprints contain no timestamp formats (e.g. YYYY-MM-DD, ISO)', () => {
  for (const key of Object.keys(BUG_FINGERPRINT_REGISTRY)) {
    assert.doesNotMatch(key, /20\d{2}/, `${key} looks like it contains a year`);
  }
});

test('fingerprints contain no UUID patterns', () => {
  for (const key of Object.keys(BUG_FINGERPRINT_REGISTRY)) {
    assert.doesNotMatch(
      key,
      /[0-9a-f]{8}-[0-9a-f]{4}/i,
      `${key} looks like it contains a UUID`
    );
  }
});
