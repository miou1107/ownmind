import { useState, useEffect } from 'react';
import { apiGet } from '../api';

// Reads the running server's version, for the footer and the sidebar. Returns a
// display-ready label such as "v1.26.43", or '' until it is known.
//
// Why over the wire rather than a build-time constant: this replaces a hardcoded
// 'v1.20.1' that sat in App.jsx from v1.20.1 onward. A build-time constant would
// fix today's drift but reintroduce the same class of problem, because a cached
// bundle would keep reporting its own build version after the server moved on.
// The footer's job is to say which OwnMind you are talking to.
//
// MUST be called from a component that only renders once authenticated -- today
// that is Layout, which sits beneath RequireAuth. Calling it from App instead
// looks equivalent and is not: App mounts once, outside the auth gate, so on a
// cold visit the request goes out with no key, takes a 401, and the effect never
// runs again because App never unmounts across an SPA login. The version would
// then stay empty for the whole session, and the login page would emit a
// spurious auth_failed log line on every load.
//
// Cached for the lifetime of the page. Each Route element builds its own
// <Layout>, so Layout remounts on every navigation and would otherwise refetch
// per page change. A page load is also the only way to receive new client code,
// so a value cached per page load cannot disagree with the bundle rendering it.
// Only successes are cached, so a request that failed is retried rather than
// remembered.
let cached = '';

export default function useServerVersion() {
  const [version, setVersion] = useState(cached);

  useEffect(() => {
    if (cached) return undefined;
    let alive = true;
    apiGet('/api/version').then(({ ok, data }) => {
      if (!ok || !data?.version) return;
      cached = `v${data.version}`;
      // The cache is set either way; `alive` only avoids setting state on a
      // component that has already unmounted, and the next mount reads `cached`.
      if (alive) setVersion(cached);
    });
    return () => { alive = false; };
  }, []);

  return version;
}
