import { Router } from 'express';
import pricingRoutes from './pricing.js';
import eventsRoutes from './events.js';
import statsRoutes from './stats.js';

const router = Router();

router.use('/pricing', pricingRoutes);
router.use('/events', eventsRoutes);
router.use('/stats', statsRoutes);

export default router;
