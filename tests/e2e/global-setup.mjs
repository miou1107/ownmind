// Playwright global setup: bring the throwaway stack up, hand its URL to the workers, and
// return the teardown so the stack cannot outlive the run even if a spec fails.
import { startStack, stopStack } from './harness.mjs';

export default async function globalSetup() {
  const stack = await startStack();
  // Workers inherit process.env from the main process, so this is how the base URL reaches
  // the specs without a temp file.
  process.env.E2E_BASE_URL = stack.baseURL;
  return async () => {
    await stopStack(stack);
  };
}
