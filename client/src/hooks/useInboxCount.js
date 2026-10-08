import { useState, useEffect } from 'react';
import { apiGet } from '../api';
import { INBOX_CHANGED } from '../api/events';
import { inboxBadges } from './inbox-badges.js';

export { inboxBadges };

// v1.32.3 — how many things wait in 待你處理, for the number on the rail and on its tabs.
//
// Read once per Layout mount (so once per page change, the same as the version), and
// again whenever a page says the inbox changed. Pages say so by calling
// `notifyInboxChanged()` right after the server accepted an action — accept a handoff,
// keep or drop a lesson, review a task, change a bug's status — so the rail's number
// drops at the same moment the row leaves the list. Without the event the number would
// be right only after the next navigation, which is exactly when nobody is looking at it.
//
// Null until the first answer arrives, and null again after a failure: the rail shows no
// number rather than a stale or made-up one.

export function notifyInboxChanged() {
  window.dispatchEvent(new Event(INBOX_CHANGED));
}

export default function useInboxCount() {
  const [counts, setCounts] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const { ok, data } = await apiGet('/api/me/overview/pending-count');
      if (!alive) return;
      setCounts(ok && data ? data : null);
    };
    load();
    window.addEventListener(INBOX_CHANGED, load);
    return () => { alive = false; window.removeEventListener(INBOX_CHANGED, load); };
  }, []);

  return inboxBadges(counts);
}
