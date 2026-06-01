import { Router } from 'express';
import { ok } from '../lib/envelope';

export const healthzRouter = Router();

healthzRouter.get('/healthz', (req, res) => {
  res.status(200).json(ok({ status: 'ok' }, req.requestId));
});
