import { AsyncLocalStorage } from 'node:async_hooks';

import type { Notification } from '@prisma/client';
import { waitUntil } from '@vercel/functions';

import { env } from '../config/env.js';
import { toNotificationItemDTO } from './dto.js';
import { logger } from './logger.js';

/**
 * Per-request collector for notifications created during the request. A Prisma
 * `$use` middleware (see lib/prisma.ts) pushes every created Notification row
 * into the active store; the realtime middleware (middleware/realtimeCollect.ts)
 * runs each request inside `notificationSink.run([], …)` and, once the response
 * has finished successfully (so the transaction has committed), emits them.
 *
 * Outside a request (e.g. the daily-reminder cron) there's no active store, so
 * the middleware push is a no-op and those notifications just surface via the
 * FE's polling fallback.
 */
export const notificationSink = new AsyncLocalStorage<Notification[]>();

/**
 * Fire-and-forget push to the realtime server's POST /emit. Never throws and
 * never blocks the request — realtime is best-effort; the 30 s FE poll is the
 * safety net. When the env isn't configured, this is a silent no-op (so local
 * dev / tests / the cron run without a realtime server).
 */
export function emitToUsers(userIds: string[], event: string, payload?: unknown): void {
  if (!env.REALTIME_EMIT_URL || !env.REALTIME_EMIT_SECRET || userIds.length === 0) return;
  const url = `${env.REALTIME_EMIT_URL.replace(/\/+$/, '')}/emit`;
  const sent = fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-emit-secret': env.REALTIME_EMIT_SECRET,
    },
    body: JSON.stringify({ userIds, event, payload }),
  })
    .then((res) => {
      if (!res.ok) logger.warn({ status: res.status }, 'realtime emit returned non-2xx');
    })
    .catch((err) => {
      logger.warn({ err: String(err) }, 'realtime emit failed');
    });

  // CRITICAL on Vercel: the serverless function is frozen the moment the
  // response is sent, which kills this fire-and-forget fetch before it reaches
  // the realtime server (→ events silently never delivered). waitUntil keeps
  // the invocation alive until the emit settles. Outside Vercel (long-running
  // local process) waitUntil throws — the promise still runs to completion.
  try {
    waitUntil(sent);
  } catch {
    void sent;
  }
}

/** Emit one `notification:new` per created notification to its owner's room. */
export function emitNewNotifications(rows: Notification[]): void {
  for (const n of rows) {
    emitToUsers([n.userId], 'notification:new', toNotificationItemDTO(n));
  }
}