/**
 * device-fingerprint — compute a stable "origin machine fingerprint"
 * (so the server can tell which machine a report came from without
 * exposing hostname or MAC).
 *
 * Corresponds to OpenSpec proposal v1.19.14-bug-report-tool (§2.6, §IV,
 * scenarios 28-32).
 *
 * Why the OS machine ID instead of hostname + MAC:
 *   - The fourth Gemini adversarial review pointed out that under
 *     Docker / VPN / VM, hostname + MAC churn frequently: container
 *     hostnames are random container IDs, and virtual NICs from
 *     Tailscale / WireGuard etc. confuse main-NIC detection.
 *   - The OS-managed machine ID is stable across reboots:
 *     - macOS: IOPlatformUUID (permanent system ID)
 *     - Linux: /etc/machine-id (set at first boot, never changes)
 *     - Windows: registry MachineGuid
 *
 * Design points:
 *   - Computed on the fly each startup; not persisted (won't be carried
 *     away by a sync folder).
 *   - Same machine + same install path → always the same fingerprint.
 *   - Different machines (different OS IDs) → always different fingerprints.
 *   - When the OS ID is unavailable, fall back to hostname + install path
 *     and emit a fingerprint_source marker.
 *   - Pure function (options-injected for testability).
 */

import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Default OS-machine-ID provider: uses the node-machine-id package.
 * Returns null on failure (does not throw; the fallback takes over).
 */
async function defaultMachineIdProvider() {
  try {
    const machineIdModule = await import('node-machine-id');
    // The package may export default or directly export the function.
    const fn = machineIdModule.machineId || machineIdModule.default?.machineId;
    if (typeof fn !== 'function') return null;
    const id = await fn();
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

function defaultHostnameProvider() {
  try {
    return os.hostname();
  } catch {
    return 'unknown';
  }
}

/**
 * Compute the SHA-256 hash and take the first 16 hex characters.
 * @param {string} input
 * @returns {string}
 */
function sha256First16(input) {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Compute the "origin machine fingerprint."
 *
 * @param {Object} [options]
 * @param {Function} [options.machineIdProvider] - async function returning the
 *   OS machine-ID string; returns null/empty when unavailable
 * @param {Function} [options.hostnameProvider] - sync function returning the
 *   hostname (used by the fallback)
 * @param {string} [options.installPath] - OwnMind install path (defaults to
 *   this file's directory)
 * @returns {Promise<{ device_fingerprint: string, fingerprint_source: 'os_machine_id' | 'no_machine_id' }>}
 */
export async function generateDeviceFingerprint(options = {}) {
  const machineIdProvider = options.machineIdProvider || defaultMachineIdProvider;
  const hostnameProvider = options.hostnameProvider || defaultHostnameProvider;
  const installPath = options.installPath || __dirname;

  let osMachineId = null;
  try {
    osMachineId = await machineIdProvider();
  } catch {
    osMachineId = null;
  }

  if (typeof osMachineId === 'string' && osMachineId.length > 0) {
    return {
      device_fingerprint: sha256First16(`${osMachineId}|${installPath}`),
      fingerprint_source: 'os_machine_id',
    };
  }

  // Fallback: hostname + install path.
  const hostname = hostnameProvider();
  return {
    device_fingerprint: sha256First16(`hostname:${hostname}|${installPath}`),
    fingerprint_source: 'no_machine_id',
  };
}

// Internal exports for tests (not part of the public API).
export const _internals = {
  sha256First16,
  defaultMachineIdProvider,
  defaultHostnameProvider,
};
