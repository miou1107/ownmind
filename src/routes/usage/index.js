import { Router } from 'express';
import pricingRoutes from './pricing.js';
import eventsRoutes from './events.js';
import statsRoutes from './stats.js';
import exemptionsRoutes from './exemptions.js';
import adminAuditRoutes from './admin-audit.js';

const router = Router();

router.use('/pricing', pricingRoutes);
router.use('/events', eventsRoutes);
router.use('/stats', statsRoutes);
router.use('/exemptions', exemptionsRoutes);
router.use('/admin/audit', adminAuditRoutes);

export default router;
