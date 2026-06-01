import type {
  EventPublisher,
  TicketClosedEvent,
  TicketCreatedEvent,
} from '../../src/lib/events/publisher';

type RecordedCall =
  | { method: 'ticketCreated'; event: TicketCreatedEvent }
  | { method: 'ticketClosed'; event: TicketClosedEvent };

/**
 * Test EventPublisher. `failNext` lets a test simulate a transient failure;
 * once it's drained, subsequent calls record successfully. Failures throw
 * BEFORE pushing into `calls`, so `calls.length` reflects only successful
 * downstream emissions — exactly what BE-S9-E2 wants to assert.
 */
export class EventRecorder implements EventPublisher {
  calls: RecordedCall[] = [];
  failNext = 0;
  alwaysFail = false;

  async ticketCreated(event: TicketCreatedEvent): Promise<void> {
    if (this.shouldFail()) throw new Error('recorder: transient failure');
    this.calls.push({ method: 'ticketCreated', event });
  }

  async ticketClosed(event: TicketClosedEvent): Promise<void> {
    if (this.shouldFail()) throw new Error('recorder: transient failure');
    this.calls.push({ method: 'ticketClosed', event });
  }

  private shouldFail(): boolean {
    if (this.alwaysFail) return true;
    if (this.failNext > 0) {
      this.failNext -= 1;
      return true;
    }
    return false;
  }
}
