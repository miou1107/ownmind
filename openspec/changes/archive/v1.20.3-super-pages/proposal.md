# v1.20.3 — Dashboard super-admin version (Config + Broadcast + Audit)

- **Status**: stub (pending expansion after the v1.20.2 release)
- **Depends on**: v1.20.2

## One-line summary

Build the three super-admin pages under `/dashboard/super/*`: system config and pricing, broadcast management, global audit.

## In scope
- Config page: API pricing, system parameters
- Broadcast page: version broadcast, snooze management
- Audit page: global operation audit log, cross-user queries
- super_admin role guard
- Backend API: add the missing super endpoints

## Out of scope
- ❌ Legacy retirement (v1.20.4)

## Main tasks
1. Implement the Config / Broadcast / Audit three pages
2. API integration
3. Role guard tests
4. Bump to v1.20.3, release, test

Detailed tasks expand when v1.20.3 starts.
