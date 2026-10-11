// Copy a value the page still has to fetch (an API key, an install prompt carrying one).
//
// Safari only lets a page write to the clipboard inside the click itself; an await before
// writeText loses the click and Safari refuses the write. So the write starts right away
// with a ClipboardItem whose content is still a promise, and the browser fills it in when
// the value arrives. Call this synchronously from the click handler, before any await.
//
// The value's own error (e.g. the server asking for a fresh login) is what the caller sees,
// not the clipboard's generic refusal that follows from it.

export async function copyPending(valuePromise, env = {}) {
  const nav = env.nav || navigator;
  const Item = 'ClipboardItem' in env ? env.ClipboardItem : globalThis.ClipboardItem;
  const value = Promise.resolve(valuePromise);

  if (typeof Item === 'function' && nav.clipboard && typeof nav.clipboard.write === 'function') {
    const blob = value.then((text) => new Blob([text], { type: 'text/plain' }));
    const writing = nav.clipboard.write([new Item({ 'text/plain': blob })]);
    // If the value fails, the write fails too; report the value's error, not the write's.
    writing.catch(() => {});
    await value;
    await writing;
    return;
  }

  await nav.clipboard.writeText(await value);
}
