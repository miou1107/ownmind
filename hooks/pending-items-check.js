#!/usr/bin/env node
// Checks GitHub and GitLab for items waiting on the user right now and rewrites
// ~/.ownmind/state/pending-items.json. The side pane's refresh button runs this, so the pane
// shows what is waiting without opening a new conversation. Prints nothing; exit code 0.
import { checkPendingItems, defaultCollectors } from './lib/pending-items.js';

// Someone pressed the button and is waiting for the answer, so a slow host gets longer than
// the 2.5 s a session start allows. The pane gives this script 30 s in all.
const HOST_TIMEOUT_MS = 12000;
const BUDGET_MS = 15000;

// The pane reads the state file, not the text; the text keys are enough for render().
await checkPendingItems({
  t: (key) => key,
  collectors: defaultCollectors({ timeoutMs: HOST_TIMEOUT_MS }),
  budgetMs: BUDGET_MS,
});
