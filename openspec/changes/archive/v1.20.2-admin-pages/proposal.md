# v1.20.2 — Dashboard admin version (Team + Bugs)

- **Status**: stub (pending expansion after the v1.20.1 release)
- **Depends on**: v1.20.1 (personal version complete, shared components extracted)

## One-line summary

Build the two admin pages under `/dashboard/admin/*`: team and member management, bug report triage.

## In scope
- Team page: member list, usage ranking, API key management, add user (API key generated server-side)
- Bugs page: inline three-button classification (fixed / in progress / ignored), official reply editing, exclusive display (does not mix with the IR iron-rule log)
- Admin role guard
- Backend API: add the missing admin endpoints

## Out of scope
- ❌ Super-admin area (v1.20.3)
- ❌ Personal version (v1.20.1 complete)

## Main tasks
1. Implement the Team page (list + sort + filter + add Modal)
2. Implement the Bugs page (inline classification + exclusivity + official reply)
3. API integration
4. Role guard tests (non-admin cannot see it)
5. Bump to v1.20.2, release, test

Detailed tasks expand when v1.20.2 starts.
