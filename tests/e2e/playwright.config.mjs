import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// End-to-end configuration for the console.
//
// The rest of the suite is `node --test`, which cannot render React, so every assertion
// about what a role sees was source analysis. These specs drive a real browser against a
// real server, which is the only way to check that the sidebar, the route guards and the
// credential handoff behave rather than merely look right in the source.
//
// One worker and no parallelism on purpose: the specs share one stack and one database, and
// the credential-handoff spec writes browser storage that another spec would then see.
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.mjs',
  globalSetup: './global-setup.mjs',
  fullyParallel: false,
  workers: 1,
  // Bringing up postgres plus applying every migration is the slow part; the specs
  // themselves are quick.
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL,
    headless: true,
    // Screenshot and trace only on failure, so a green run leaves nothing behind.
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  // Failure screenshots and traces go to the OS temp directory, not into the repository.
  // They are debugging by-products of one run, so there is nothing for git to ignore and
  // nothing left in the working tree to tidy up afterwards.
  outputDir: join(tmpdir(), 'ownmind-e2e-artifacts'),
});
