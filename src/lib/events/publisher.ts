import type { Severity } from '@prisma/client';
import { env } from '../../config/env';
import { logger } from '../logger';
import { LoggerEventPublisher } from './logger-adapter';
import { QStashEventPublisher } from './qstash-adapter';

export interface TicketCreatedEvent {
  type: 'ticketCreated';
  ticketId: string;
  code: string;
  severity: Severity;
  requesterId: string;
  createdAt: Date;
}

export interface TicketClosedEvent {
  type: 'ticketClosed';
  ticketId: string;
  code: string;
  status: 'Closed';
  closedAt: Date;
  requesterId: string;
}

/**
 * Downstream-event boundary. Implementations push to a transport (pino logger
 * in dev, QStash → ESB in prod). Always called **after** the ticket Prisma
 * transaction commits — a publisher failure must never roll back the ticket.
 */
export interface EventPublisher {
  ticketCreated(event: TicketCreatedEvent): Promise<void>;
  ticketClosed(event: TicketClosedEvent): Promise<void>;
}

// ─────────────── Singleton + injection point for tests ───────────────

let current: EventPublisher | null = null;

export function setPublisher(p: EventPublisher | null): void {
  current = p;
}

export function getPublisher(): EventPublisher {
  if (current) return current;
  current = createFromEnv();
  return current;
}

function createFromEnv(): EventPublisher {
  if (env.EVENT_PUBLISHER_DRIVER === 'qstash') {
    // Env refine guarantees QSTASH_TOKEN is set when driver==='qstash'.
    return new QStashEventPublisher(env.QSTASH_TOKEN!);
  }
  return new LoggerEventPublisher();
}

// ─────────────── Safe-publish wrappers (caller-friendly) ───────────────
//
// One synchronous attempt + one immediate retry. Anything beyond that gets
// logged at error level. The publisher boundary swallows all errors so the
// caller (a ticket-creating or ticket-closing handler) cannot fail because of
// downstream delivery problems.

const RETRY_COUNT = 1; // 1 initial + 1 retry = 2 total attempts

export async function safePublishCreated(event: TicketCreatedEvent): Promise<void> {
  await tryPublish('ticketCreated', event);
}

export async function safePublishClosed(event: TicketClosedEvent): Promise<void> {
  await tryPublish('ticketClosed', event);
}

async function tryPublish(
  method: 'ticketCreated' | 'ticketClosed',
  event: TicketCreatedEvent | TicketClosedEvent,
): Promise<void> {
  const pub = getPublisher();
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
    try {
      if (method === 'ticketCreated') {
        await pub.ticketCreated(event as TicketCreatedEvent);
      } else {
        await pub.ticketClosed(event as TicketClosedEvent);
      }
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  logger.error({ method, event, err: lastErr }, `EventPublisher.${method} failed after retries`);
}
