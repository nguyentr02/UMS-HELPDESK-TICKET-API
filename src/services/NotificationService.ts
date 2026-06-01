import { prisma } from '../lib/prisma.js';
import { ForbiddenError, NotFoundError } from '../lib/errors.js';
import { toNotificationItemDTO } from '../lib/dto.js';
import type { SessionUser } from '../middleware/auth.js';
import { UserService } from './UserService.js';

export interface ListQuery {
  page?: number;
  pageSize?: number;
  unreadOnly?: boolean;
}

export const NotificationService = {
  /**
   * Caller's own inbox. Sort: unread (readAt=NULL) first, then within each
   * group `createdAt DESC`. FE consumes a flat `NotificationItem[]`; we still
   * limit results server-side (default 100 — practice mode) so the response
   * stays bounded.
   */
  async listForCaller(caller: SessionUser, query: ListQuery = {}) {
    await UserService.ensureFromSession(caller);

    const pageSize = Math.max(1, Math.min(200, Math.floor(query.pageSize ?? 100)));

    const where = {
      userId: caller.id,
      ...(query.unreadOnly ? { readAt: null } : {}),
    };

    const items = await prisma.notification.findMany({
      where,
      orderBy: [
        { readAt: { sort: 'desc', nulls: 'first' } },
        { createdAt: 'desc' },
      ],
      take: pageSize,
    });

    return items.map(toNotificationItemDTO);
  },

  async markRead(id: string, caller: SessionUser) {
    await UserService.ensureFromSession(caller);

    const n = await prisma.notification.findUnique({ where: { id } });
    if (!n) throw new NotFoundError('Không tìm thấy thông báo');
    if (n.userId !== caller.id) {
      throw new ForbiddenError('Không có quyền với thông báo này');
    }
    if (n.readAt) return toNotificationItemDTO(n); // idempotent — already marked

    const updated = await prisma.notification.update({
      where: { id },
      data: { readAt: new Date() },
    });
    return toNotificationItemDTO(updated);
  },
};
