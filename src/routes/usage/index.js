import { Router } from 'express';
import pricingRoutes from './pricing.js';

const router = Router();

router.use('/pricing', pricingRoutes);

export default router;
