#!/usr/bin/env node
// Prints one OwnMind task card or bug report in full: `pending-items-show.js task 3`,
// `pending-items-show.js bug 32`. The side pane's prompt hook runs this when the person sends
// "show task card #3" and hands the text to the model with that prompt. Prints nothing when the
// item cannot be read; exit code 0 either way.
import { describeOwnMindItem } from './lib/pending-items.js';

const [kind, id] = process.argv.slice(2);
// One item for someone who has just pressed Enter: longer than a session start allows a host.
const text = await describeOwnMindItem({ kind, id, timeoutMs: 6000 });
if (text) process.stdout.write(`${text}\n`);
