# v1.20.1 — Dashboard personal edition (Portal + Preference)

- **Status**: stub (to be expanded after the v1.20.0 release)
- **Depends on**: v1.20.0 (foundation complete)

## One-sentence summary

Fill the empty-shell pages of `/dashboard/portal/*` (personal usage, project history, work handoff, report records) and `/dashboard/preference/*` (personal profile, account/password, secret management) with actual content, and connect them to the backend API.

## In scope
- Portal 4 pages: usage analysis, project history, work handoff, report records
- Preference 3 pages: personal profile, account/password change, secret management
- Extract shared components: Sidebar, TopBar, FilterBar, Footer, Modal, RoleBadge, StatCard
- Connect to backend APIs: sessions / handoffs / reports / users / secrets
- `client/src/api/` unified API client module

## Out of scope
- ❌ Admin area (v1.20.2)
- ❌ Super-admin area (v1.20.3)
- ❌ Legacy retirement (v1.20.4)

## Main tasks
1. Split out shared components
2. Implement 7 pages
3. Fill in backend API endpoints (add whatever is missing)
4. Add e2e tests (login + view usage + accept handoff)
5. Bump to v1.20.1, release, and verify

Detailed tasks are expanded when v1.20.1 kicks off.
