import type { NextFunction, Request, Response } from 'express';
import type { Notification } from '@prisma/client';

import { emitNewNotifications, notificationSink } from '../lib/realtime.js';

/**
 * Runs each request inside a `notificationSink` context so the Prisma `$use`
 * middleware can collect notifications created during the request. Once the
 * response finishes *successfully* (status < 400 ⇒ the transaction committed),
 * pushes them over the socket. Failures (rolled-back tx → error response) skip
 * the emit, so the FE never gets a `notification:new` for a row that doesn't
 * exist.
 */
export function realtimeCollectMiddleware(_req: Request, res: Response, next: NextFunction) {
  const store: Notification[] = [];
  res.on('finish', () => {
    if (res.statusCode < 400 && store.length > 0) {
      emitNewNotifications(store);
    }
  });
  notificationSink.run(store, () => next());
}