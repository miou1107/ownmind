// v1.26.60 removed two sub-routers.
//
// `/pricing` went with the cost calculation (Requirement 8). Deleting it also closed an
// authorization gap that had been open the whole time: the GET was mounted with plain
// `auth` while only the POST was `superAdminAuth`, so any signed-in user could read the
// price table, and the legacy console merely hid the card client-side using the
// user-writable `om_role` key.
//
// `/exemptions` was a super_admin CRUD with no UI anywhere and zero rows on production.
// The `usage_tracking_exemption` table stays — team-stats.js reads it to keep the
// coverage denominator honest — but nothing serves CRUD over it any more.

import { Router } from 'express';
import eventsRoutes from './events.js';
import statsRoutes from './stats.js';
import teamStatsRoutes from './team-stats.js';
import adminAuditRoutes from './admin-audit.js';
import adminClientsRoutes from './admin-clients.js';
import teamOverviewRoutes from './team-overview.js';

const router = Router();

router.use('/events', eventsRoutes);
router.use('/stats', statsRoutes);
router.use('/team-stats', teamStatsRoutes);
router.use('/admin/audit', adminAuditRoutes);
router.use('/admin/clients', adminClientsRoutes);
router.use('/admin/team-overview', teamOverviewRoutes);

export default router;
