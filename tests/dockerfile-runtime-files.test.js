// v1.26.60 — every file the runtime reaches for has to be in the image.
//
// The specific landmine this defuses: `npm start` gained a `prestart` hook running
// scripts/ensure-console-build.js. The Dockerfile's CMD calls node directly, so npm never
// runs it and the omission would be invisible — until someone changed CMD to `npm start`,
// which would then fail at boot with "cannot find module" and no hint why.
//
// Generalised rather than hardcoded to that one file: the same shape of bug is the reason
// the project rule about adding a Dockerfile COPY whenever server code reaches a new path
// exists at all.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dockerfile = readFileSync(join(repoRoot, 'Dockerfile'), 'utf8');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

/** Lifecycle hooks npm runs around `start`, which is what the container may invoke. */
const START_HOOKS = ['prestart', 'start', 'poststart'];

describe('Dockerfile carries what the start path executes', () => {
  it('every scripts/ file named by a start hook is COPYed into the image', () => {
    const referenced = new Set();
    for (const hook of START_HOOKS) {
      const cmd = pkg.scripts?.[hook];
      if (!cmd) continue;
      for (const m of cmd.matchAll(/scripts\/[\w.-]+\.(?:js|mjs|cjs|sh)/g)) {
        referenced.add(m[0]);
      }
    }
    // The hooks must actually mention something, or this test silently covers nothing.
    assert.ok(referenced.size > 0, 'no scripts/ file is referenced by a start hook');

    // Matched against the COPY directives, not the whole file. `includes()` would also
    // be satisfied by a comment mentioning the path — and the comment right above that
    // COPY does explain why it is there, so the weaker check was one edit from vacuous.
    const copied = [...dockerfile.matchAll(/^COPY\s+(?:--from=\S+\s+)?(\S+)/gm)].map((m) => m[1]);
    for (const file of referenced) {
      assert.ok(
        copied.includes(file),
        `${file} runs on the start path but no Dockerfile COPY brings it into the image`,
      );
    }
  });

  it('nothing under legacy/ is copied into the image', () => {
    // The retired /me and /admin consoles live there. They are preserved as a record and
    // must not ship: an unreferenced copy of an old admin console inside the runtime image
    // is a file that can only ever be served by accident.
    const copies = [...dockerfile.matchAll(/^COPY\s+(?:--from=\S+\s+)?(\S+)/gm)].map((m) => m[1]);
    for (const src of copies) {
      assert.ok(!src.startsWith('legacy'), `Dockerfile copies ${src}, which is a retired console`);
    }
  });

  it('the console build is what gets served, and it comes from the builder stage', () => {
    assert.match(
      dockerfile,
      /COPY --from=client-builder \S*src\/public\/dashboard\/ \.\/src\/public\/dashboard\//,
    );
  });
});
