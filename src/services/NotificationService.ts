import { prisma } from '../lib/prisma.js';
import { ForbiddenError, NotFoundError } from '../lib/errors.js';
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
   * group `createdAt DESC`. The `nulls: 'first'` order option puts unread
   * ahead; `createdAt: 'desc'` breaks ties so the newest unread is on top.
   */
  async listForCaller(caller: SessionUser, query: ListQuery = {}) {
    await UserService.ensureFromSession(caller);

    const page = Math.max(1, Math.floor(query.page ?? 1));
    const pageSize = Math.max(1, Math.min(100, Math.floor(query.pageSize ?? 20)));

    const where = {
      userId: caller.id,
      ...(query.unreadOnly ? { readAt: null } : {}),
    };

    const [items, total, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: [
          { readAt: { sort: 'desc', nulls: 'first' } },
          { createdAt: 'desc' },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { userId: caller.id, readAt: null } }),
    ]);

    return { items, page, pageSize, total, unreadCount };
  },

  async markRead(id: string, caller: SessionUser) {
    await UserService.ensureFromSession(caller);

    const n = await prisma.notification.findUnique({ where: { id } });
    if (!n) throw new NotFoundError('Không tìm thấy thông báo');
    if (n.userId !== caller.id) {
      throw new ForbiddenError('Không có quyền với thông báo này');
    }
    if (n.readAt) return n; // idempotent — already marked

    return prisma.notification.update({
      where: { id },
      data: { readAt: new Date() },
    });
  },
};
