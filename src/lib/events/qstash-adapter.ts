import type { EventPublisher, TicketClosedEvent, TicketCreatedEvent } from './publisher';

/**
 * Production publisher stub. Real impl would POST to Upstash QStash with the
 * shared token; QStash retries delivery to the configured ESB destination.
 * Practice-mode build never actually deploys this — left as a placeholder so
 * the env switch (`EVENT_PUBLISHER_DRIVER=qstash`) keeps compiling.
 */
export class QStashEventPublisher implements EventPublisher {
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(private readonly _token: string) {}

  async ticketCreated(_event: TicketCreatedEvent): Promise<void> {
    throw new Error('QStashEventPublisher not implemented in practice mode');
  }

  async ticketClosed(_event: TicketClosedEvent): Promise<void> {
    throw new Error('QStashEventPublisher not implemented in practice mode');
  }
}
