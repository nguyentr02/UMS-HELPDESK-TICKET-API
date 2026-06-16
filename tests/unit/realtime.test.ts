import { afterEach, describe, expect, it, vi } from 'vitest';

import { emitNewNotifications, emitToUsers } from '../../src/lib/realtime.js';

/**
 * The test env never sets REALTIME_EMIT_URL/SECRET, so realtime must be inert —
 * no outbound fetch, no throw. This guards the "realtime disabled" safety net
 * that keeps the BE (and the whole test suite) working without a socket server.
 */
describe('lib/realtime — disabled when env is unset', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emitToUsers makes no fetch when REALTIME_EMIT_URL is unset', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    emitToUsers(['u-1', 'u-2'], 'notification:new', { id: 'n1' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('emitNewNotifications is a no-op (no fetch, no throw) when disabled', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const now = new Date();
    expect(() =>
      emitNewNotifications([
        {
          id: 'n1',
          userId: 'u-1',
          type: 'TicketAssigned',
          ticketId: 't-1',
          payload: { ticketCode: 'HD-1' },
          readAt: null,
          createdAt: now,
        },
      ]),
    ).not.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('emitToUsers skips empty recipient lists', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    emitToUsers([], 'notification:new', {});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});