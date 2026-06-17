import type { NextFunction, Request, Response } from 'express';

import { emitBroadcast, emitNewNotifications, realtimeSink, type RealtimeSink } from '../lib/realtime.js';

/**
 * Runs each request inside a `realtimeSink` context so the Prisma `$use`
 * middleware can record what changed. Once the response finishes *successfully*
 * (status < 400 ⇒ the transaction committed), pushes:
 *   - one `notification:new` per created notification (to its owner), and
 *   - a single `tickets:changed` broadcast if any ticket was written (so open
 *     queues/lists + the dashboard refetch live).
 * Failures (rolled-back tx → error response) skip the emit, so the FE never
 * gets an event for a change that didn't persist.
 */
export function realtimeCollectMiddleware(_req: Request, res: Response, next: NextFunction) {
  const store: RealtimeSink = { notifications: [], ticketTouched: false };
  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    if (store.notifications.length > 0) emitNewNotifications(store.notifications);
    if (store.ticketTouched) emitBroadcast('tickets:changed');
  });
  realtimeSink.run(store, () => next());
}