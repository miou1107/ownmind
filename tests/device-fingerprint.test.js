import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateDeviceFingerprint,
  _internals,
} from '../shared/device-fingerprint.js';

// ============================================================
// Normal case: OS machine ID is available → use it
// ============================================================

test('normal case: compute fingerprint from OS machine ID + install path', async () => {
  const fp = await generateDeviceFingerprint({
    machineIdProvider: async () => 'os-machine-id-abc-123',
    installPath: '/usr/local/ownmind',
  });
  assert.equal(typeof fp.device_fingerprint, 'string');
  assert.equal(fp.device_fingerprint.length, 16);
  assert.equal(fp.fingerprint_source, 'os_machine_id');
});

test('same input yields the same fingerprint (stability)', async () => {
  const opts = {
    machineIdProvider: async () => 'os-id-xyz',
    installPath: '/path/to/install',
  };
  const fp1 = await generateDeviceFingerprint(opts);
  const fp2 = await generateDeviceFingerprint(opts);
  const fp3 = await generateDeviceFingerprint(opts);
  assert.equal(fp1.device_fingerprint, fp2.device_fingerprint);
  assert.equal(fp2.device_fingerprint, fp3.device_fingerprint);
});

test('different OS machine IDs yield different fingerprints', async () => {
  const fpA = await generateDeviceFingerprint({
    machineIdProvider: async () => 'machine-A',
    installPath: '/x',
  });
  const fpB = await generateDeviceFingerprint({
    machineIdProvider: async () => 'machine-B',
    installPath: '/x',
  });
  assert.notEqual(fpA.device_fingerprint, fpB.device_fingerprint);
});

test('same OS ID + different install path → different fingerprint', async () => {
  const fpA = await generateDeviceFingerprint({
    machineIdProvider: async () => 'same-id',
    installPath: '/path/A',
  });
  const fpB = await generateDeviceFingerprint({
    machineIdProvider: async () => 'same-id',
    installPath: '/path/B',
  });
  assert.notEqual(fpA.device_fingerprint, fpB.device_fingerprint);
});

// ============================================================
// Fallback: OS machine ID unavailable → use hostname + install path
// ============================================================

test('OS ID unavailable (throws) → fallback to hostname + install path', async () => {
  const fp = await generateDeviceFingerprint({
    machineIdProvider: async () => {
      throw new Error('no /etc/machine-id');
    },
    hostnameProvider: () => 'my-laptop',
    installPath: '/path',
  });
  assert.equal(typeof fp.device_fingerprint, 'string');
  assert.equal(fp.device_fingerprint.length, 16);
  assert.equal(fp.fingerprint_source, 'no_machine_id');
});

test('OS ID returns an empty string → treated as unavailable, use fallback', async () => {
  const fp = await generateDeviceFingerprint({
    machineIdProvider: async () => '',
    hostnameProvider: () => 'host',
    installPath: '/p',
  });
  assert.equal(fp.fingerprint_source, 'no_machine_id');
});

test('fallback: same input yields the same fingerprint', async () => {
  const opts = {
    machineIdProvider: async () => null,
    hostnameProvider: () => 'host-x',
    installPath: '/p',
  };
  const fp1 = await generateDeviceFingerprint(opts);
  const fp2 = await generateDeviceFingerprint(opts);
  assert.equal(fp1.device_fingerprint, fp2.device_fingerprint);
});

// ============================================================
// SHA-256 hash logic
// ============================================================

test('SHA-256 hash takes the first 16 chars and is hex', async () => {
  const fp = await generateDeviceFingerprint({
    machineIdProvider: async () => 'test-id',
    installPath: '/x',
  });
  assert.match(fp.device_fingerprint, /^[0-9a-f]{16}$/);
});

// ============================================================
// Default behavior (no options passed) does not crash
// ============================================================

test('runs without options (using real node-machine-id or fallback)', async () => {
  const fp = await generateDeviceFingerprint();
  assert.equal(typeof fp.device_fingerprint, 'string');
  assert.equal(fp.device_fingerprint.length, 16);
  assert.ok(
    ['os_machine_id', 'no_machine_id'].includes(fp.fingerprint_source),
    `fingerprint_source 應是合法值、實際 ${fp.fingerprint_source}`
  );
});
