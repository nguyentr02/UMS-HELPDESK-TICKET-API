import { logger } from '../logger';
import type { EventPublisher, TicketClosedEvent, TicketCreatedEvent } from './publisher';

/** Dev / test default — records each event to the pino logger. */
export class LoggerEventPublisher implements EventPublisher {
  async ticketCreated(event: TicketCreatedEvent): Promise<void> {
    logger.info({ event }, 'EventPublisher.ticketCreated');
  }

  async ticketClosed(event: TicketClosedEvent): Promise<void> {
    logger.info({ event }, 'EventPublisher.ticketClosed');
  }
}
