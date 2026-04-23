import { Router } from 'express';
import pricingRoutes from './pricing.js';
import eventsRoutes from './events.js';
import statsRoutes from './stats.js';
import teamStatsRoutes from './team-stats.js';
import exemptionsRoutes from './exemptions.js';
import adminAuditRoutes from './admin-audit.js';
import adminClientsRoutes from './admin-clients.js';

const router = Router();

router.use('/pricing', pricingRoutes);
router.use('/events', eventsRoutes);
router.use('/stats', statsRoutes);
router.use('/team-stats', teamStatsRoutes);
router.use('/exemptions', exemptionsRoutes);
router.use('/admin/audit', adminAuditRoutes);
router.use('/admin/clients', adminClientsRoutes);

export default router;
