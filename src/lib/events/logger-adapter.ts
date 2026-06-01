import { logger } from '../logger.js';
import type { EventPublisher, TicketClosedEvent, TicketCreatedEvent } from './publisher.js';

/** Dev / test default — records each event to the pino logger. */
export class LoggerEventPublisher implements EventPublisher {
  async ticketCreated(event: TicketCreatedEvent): Promise<void> {
    logger.info({ event }, 'EventPublisher.ticketCreated');
  }

  async ticketClosed(event: TicketClosedEvent): Promise<void> {
    logger.info({ event }, 'EventPublisher.ticketClosed');
  }
}
