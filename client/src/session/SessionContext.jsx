// Who the current user is, according to the server.
//
// Before this existed, App.jsx seeded the role with useState('super_admin') and the
// sidebar filtered its sections against that literal. Every user who logged in saw the
// admin and super sections. The pages behind them were empty shells, so nothing leaked,
// but the moment those pages exist the console would be showing admin tools to members.
//
// The role is deliberately NOT persisted. The old console kept it in the `om_role`
// localStorage key and restored it on load, which meant a member could edit that key in
// devtools and reveal admin-only cards. Holding it in memory removes that: the only
// source is the server, which resolves the user from the api_key.
//
// Client-side gating is a UX measure either way. The server still enforces on every
// endpoint; this stops the console from *offering* what the server would refuse.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { apiGet, getApiKey, clearApiKey } from '../api';
import { AUTH_EXPIRED, SESSION_CHANGED } from '../api/events';

// `id` is carried because the legacy console restores its session from `om_user_id`
// (src/public/index.html), so a signpost that hands the credential across needs it.
const EMPTY = { id: null, role: null, name: '', email: '', mustChangePassword: false };

const SessionContext = createContext(null);

export function SessionProvider({ children }) {
  // Three-part state, and the distinction matters:
  //   ready  — we have an answer, right or wrong. Guards must wait for it.
  //   error  — we asked and could not find out. Different from "logged out".
  // Collapsing error into "no role" was a defect review caught: a three-second database
  // blip left a logged-in super_admin looking at an empty sidebar named "Guest", with no
  // explanation and no way back except a manual reload.
  const [state, setState] = useState({ ...EMPTY, ready: false, error: false });

  // Monotonic token so a slow response cannot overwrite a newer one. The previous
  // version used an `alive` boolean that was cleared in the same cleanup that removed the
  // listener, so it guarded nothing: log out and back in as someone else without
  // reloading, and the first user's late response would land last and win.
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    if (!getApiKey()) {
      setState({ ...EMPTY, ready: true, error: false });
      return;
    }
    // Mark in flight so guards wait rather than deciding against a stale identity.
    setState((s) => ({ ...s, ready: false, error: false }));
    const { ok, data } = await apiGet('/api/me/profile');
    if (id !== requestId.current) return;
    if (!ok || !data) {
      // A 401 already triggers the auth-expired path in api/client.js. Anything else is
      // an unknown identity, which is recorded as an error rather than as "no role".
      setState({ ...EMPTY, ready: true, error: true });
      return;
    }
    setState({
      ready: true,
      error: false,
      id: data.id ?? null,
      role: data.role ?? null,
      name: data.name ?? '',
      email: data.email ?? '',
      mustChangePassword: !!data.must_change_password,
    });
  }, []);

  // Seed the identity straight from a login response.
  //
  // Without this the console had a deterministic defect, not a race: LoginPage calls
  // setApiKey and then navigate() in the same synchronous block, so the profile request
  // cannot possibly have resolved by the time the destination renders. An admin who
  // deep-linked to an admin page, got bounced to /login, and signed in correctly was then
  // sent to /portal/usage every time, because the guard saw a resolved-but-role-less
  // session. POST /api/me/login already returns the identity, so priming closes the
  // window and removes a round trip at the same time.
  const prime = useCallback((data) => {
    if (!data) return;
    requestId.current += 1;
    setState({
      ready: true,
      error: false,
      id: data.id ?? null,
      role: data.role ?? null,
      name: data.name ?? '',
      email: data.email ?? '',
      mustChangePassword: !!data.must_change_password,
    });
  }, []);

  useEffect(() => {
    load();
    window.addEventListener(SESSION_CHANGED, load);
    return () => window.removeEventListener(SESSION_CHANGED, load);
  }, [load]);

  const logout = useCallback(() => {
    // clearApiKey announces the change, which resets this provider. The redirect is left
    // to the existing auth-expired listener in App so there is one way in and one way out
    // of /login.
    clearApiKey();
    window.dispatchEvent(new Event(AUTH_EXPIRED));
  }, []);

  return (
    <SessionContext.Provider value={{ ...state, refresh: load, prime, logout }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  // Falling back to a resolved-but-anonymous session keeps components usable outside the
  // provider instead of throwing. It fails closed for the route guards, at the cost of
  // turning a wiring mistake into "everyone is a guest" rather than a loud error.
  return useContext(SessionContext) ?? {
    ...EMPTY, ready: true, error: false, refresh: () => {}, prime: () => {}, logout: () => {},
  };
}
