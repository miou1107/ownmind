import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { startRealDb, reclaimAbandonedContainersOn } from './helpers/real-db.js';

/**
 * The database a test container writes is gone once the container is.
 *
 * The postgres image declares `VOLUME /var/lib/postgresql/data`, so every `docker run` of it creates
 * an anonymous volume for the data directory. `docker rm -f` removes the container and leaves that
 * volume behind, unreferenced: nothing will ever mount it again, and nothing lists it except
 * `docker volume ls`. Seven DB-backed test files each start a container, so every full suite run
 * left about seven. Measured 2026-10-21 on the maintainer's Mac: 549 of them, about 49 MB each,
 * 28 GB of a disk that had 14 GB left.
 *
 * Against real docker rather than a stub, because the property is what docker keeps, not which
 * flags the helper passes.
 */

/** The names of the volumes `container` mounts. */
function volumesOf(container) {
  return execFileSync('docker', ['inspect', '--format',
    '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}', container],
  { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
}

/**
 * Whether docker still has a volume called `name`.
 *
 * Only docker's own "no such volume" counts as gone. Any other failure — a daemon that stopped
 * answering — is thrown, or this would read as the volume having been removed and pass.
 */
function volumeExists(name) {
  try {
    execFileSync('docker', ['volume', 'inspect', name], { stdio: ['ignore', 'ignore', 'pipe'] });
    return true;
  } catch (err) {
    if (/no such volume/i.test(String(err?.stderr || ''))) return false;
    throw err;
  }
}

test('stop() removes the data volume with the container', async (t) => {
  const db = await startRealDb();
  if (!db) {
    t.skip('docker is not available on this machine, so the cleanup was NOT exercised');
    return;
  }
  let volumes;
  try {
    volumes = volumesOf(db.name);
  } finally {
    db.stop();
  }
  // Without a volume to watch, the assertion below would pass for an image that simply does not
  // declare one, and say nothing about the helper.
  assert.ok(volumes.length > 0, `${db.name} mounted no volume, so there was nothing to clean up`);
  assert.deepEqual(volumes.filter(volumeExists), [],
    'stop() left the container\'s data volume behind');
});

test('reclaiming an abandoned container removes its data volume too', async (t) => {
  const db = await startRealDb();
  if (!db) {
    t.skip('docker is not available on this machine, so the cleanup was NOT exercised');
    return;
  }
  let volumes;
  try {
    volumes = volumesOf(db.name);
    // The lock is ours, so this container stands in for one a killed process left running.
    assert.deepEqual(reclaimAbandonedContainersOn(db.port), [db.name]);
  } finally {
    db.stop();
  }
  assert.ok(volumes.length > 0, `${db.name} mounted no volume, so there was nothing to clean up`);
  assert.deepEqual(volumes.filter(volumeExists), [],
    'reclaimAbandonedContainersOn() left the container\'s data volume behind');
});
