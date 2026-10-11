/**
 * copyPending() — copying a value the page still has to fetch (an API key, an install
 * prompt that carries one).
 *
 * Safari only lets a page write to the clipboard inside the click itself. The team page
 * used to await the key and then call writeText, which Safari refuses, so both copy
 * buttons failed there. copyPending must start the clipboard write before it waits.
 *
 * The key copy button also used to swallow the server's reason ("log in again within
 * 15 minutes") and show a bare "copy failed"; the fetch error must reach the caller.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyPending } from '../client/src/utils/copy-pending.js';

class FakeClipboardItem {
  constructor(items) { this.items = items; }
}

function fakeNavigator() {
  const calls = [];
  return {
    calls,
    clipboard: {
      async write(items) {
        calls.push('write');
        const blob = await items[0].items['text/plain'];
        calls.push(`wrote:${await blob.text()}`);
      },
      async writeText(text) { calls.push(`writeText:${text}`); },
    },
  };
}

describe('copyPending', () => {
  it('starts the clipboard write before the value arrives', async () => {
    const nav = fakeNavigator();
    let resolve;
    const pending = new Promise((r) => { resolve = r; });
    const done = copyPending(pending, { nav, ClipboardItem: FakeClipboardItem });
    assert.deepEqual(nav.calls, ['write'], 'write must be called synchronously, inside the click');
    resolve('sk-123');
    await done;
    assert.deepEqual(nav.calls, ['write', 'wrote:sk-123']);
  });

  it('passes the fetch error through instead of a generic clipboard error', async () => {
    const nav = fakeNavigator();
    const reason = new Error('log in again within 15 minutes');
    await assert.rejects(
      copyPending(Promise.reject(reason), { nav, ClipboardItem: FakeClipboardItem }),
      (err) => err === reason,
    );
  });

  it('falls back to writeText where ClipboardItem does not exist', async () => {
    const nav = fakeNavigator();
    await copyPending(Promise.resolve('sk-9'), { nav, ClipboardItem: undefined });
    assert.deepEqual(nav.calls, ['writeText:sk-9']);
  });
});
