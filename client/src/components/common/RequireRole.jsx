import { Navigate } from 'react-router-dom';
import { useSession } from '../../session/SessionContext';
import { decideRoleGate, ROLE_DENIED_REDIRECT } from '../../session/roles';

// Route guard for role, the companion to RequireAuth's guard for "is there a session".
// RequireAuth answers "are you logged in"; this answers "are you allowed here".
//
// Without it the sidebar was the only gate, so typing /dashboard/admin/team reached the
// page regardless of role. The server refuses the data, but the page still renders and
// fails in a way that looks like a bug rather than a permission boundary.
//
// The decision itself lives in session/roles.js so it can be executed by tests. It used
// to be inline here, guarded by a test that checked whether the word "ready" appeared
// before "<Navigate>" in this file — an assertion that passes for a guard which checks
// the role first and readiness second, i.e. for the exact bug it claimed to prevent.
export default function RequireRole({ min, children }) {
  const { role, ready } = useSession();

  switch (decideRoleGate({ ready, role, min })) {
    // Identity still in flight. Rendering nothing is correct: deciding now would send a
    // legitimate admin away, because an unresolved session looks like a role-less one.
    case 'wait':
      return null;
    case 'deny':
      return <Navigate to={ROLE_DENIED_REDIRECT} replace />;
    default:
      return children;
  }
}
