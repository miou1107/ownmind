import { useState, useEffect } from 'react';
import { apiGet } from '../api';

// Reads the running server's release notes, for the footer's changelog modal.
// Returns [] until they arrive, which is also what the modal's empty state
// renders — so a slow or failed request looks like the old behaviour rather
// than an error.
//
// Why over the wire rather than bundled: CHANGELOG.md lives at the repo root and
// the server already reads it. Importing it into the client bundle would mean a
// cached bundle keeps listing its own build's releases after the server moved
// on, which is the exact drift useServerVersion exists to undo.
//
// MUST be called from a component that only renders once authenticated -- today
// that is Layout, beneath RequireAuth. See the longer note in useServerVersion:
// calling it from App instead takes a 401 on a cold visit and never retries.
//
// Cached for the lifetime of the page, for the same reason the version is:
// Layout remounts on every navigation, and CHANGELOG.md cannot change without a
// new server process.
//
// A failed request is not cached and is retried on the next navigation. A
// successful one is, *including* an empty list — a server that answers `[]` is
// missing CHANGELOG.md from its image and will answer `[]` for its whole life,
// so re-asking every navigation would buy nothing. Note that this is why the
// cache is seeded with null rather than []: unlike useServerVersion's '', an
// empty array is truthy, so the sentinel has to be something else.
let cached = null;

export default function useChangelog() {
  const [entries, setEntries] = useState(cached || []);

  useEffect(() => {
    if (cached) return undefined;
    let alive = true;
    apiGet('/api/changelog').then(({ ok, data }) => {
      if (!ok || !Array.isArray(data?.entries)) return;
      cached = data.entries;
      if (alive) setEntries(cached);
    });
    return () => { alive = false; };
  }, []);

  return entries;
}
