import { AsyncLocalStorage } from 'node:async_hooks';

import type { Notification } from '@prisma/client';
import { waitUntil } from '@vercel/functions';

import { env } from '../config/env.js';
import { toNotificationItemDTO } from './dto.js';
import { logger } from './logger.js';

/**
 * Per-request realtime collector. A Prisma `$use` middleware (see lib/prisma.ts)
 * records, into the active store, every Notification created and whether any
 * Ticket row was written. The realtime middleware (middleware/realtimeCollect.ts)
 * runs each request inside `realtimeSink.run(...)` and, once the response has
 * finished successfully (so the transaction committed), emits:
 *   - one `notification:new` per created notification (to its owner), and
 *   - a single `tickets:changed` broadcast if any ticket was mutated (so every
 *     open queue/list — and the dashboard — refetches live).
 *
 * Outside a request (e.g. the daily-reminder cron) there's no active store, so
 * the middleware records nothing and those changes surface via the FE poll.
 */
export interface RealtimeSink {
  notifications: Notification[];
  ticketTouched: boolean;
}
export const realtimeSink = new AsyncLocalStorage<RealtimeSink>();

/**
 * Fire-and-forget push to the realtime server's POST /emit. Never throws and
 * never blocks the request — realtime is best-effort; the 30 s FE poll is the
 * safety net. When the env isn't configured, this is a silent no-op (so local
 * dev / tests / the cron run without a realtime server).
 */
/**
 * Fire-and-forget POST to the realtime server's /emit. Never throws/blocks; a
 * silent no-op when the env isn't configured (local/test/cron).
 *
 * CRITICAL on Vercel: the serverless function is frozen the moment the response
 * is sent, which kills an un-awaited fetch before it reaches the realtime
 * server (→ events silently never delivered). waitUntil keeps the invocation
 * alive until the emit settles. Outside Vercel (long-running local process)
 * waitUntil throws — the promise still runs to completion.
 */
function postEmit(body: Record<string, unknown>): void {
  if (!env.REALTIME_EMIT_URL || !env.REALTIME_EMIT_SECRET) return;
  const url = `${env.REALTIME_EMIT_URL.replace(/\/+$/, '')}/emit`;
  const sent = fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-emit-secret': env.REALTIME_EMIT_SECRET,
    },
    body: JSON.stringify(body),
  })
    .then((res) => {
      if (!res.ok) logger.warn({ status: res.status }, 'realtime emit returned non-2xx');
    })
    .catch((err) => {
      logger.warn({ err: String(err) }, 'realtime emit failed');
    });
  try {
    waitUntil(sent);
  } catch {
    void sent;
  }
}

/** Push an event to specific users' rooms. */
export function emitToUsers(userIds: string[], event: string, payload?: unknown): void {
  if (userIds.length === 0) return;
  postEmit({ userIds, event, payload });
}

/** Push an event to every connected client (e.g. reference-data changes). */
export function emitBroadcast(event: string, payload?: unknown): void {
  postEmit({ broadcast: true, event, payload });
}

/** Emit one `notification:new` per created notification to its owner's room. */
export function emitNewNotifications(rows: Notification[]): void {
  for (const n of rows) {
    emitToUsers([n.userId], 'notification:new', toNotificationItemDTO(n));
  }
}