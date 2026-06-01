import { prisma } from '../lib/prisma.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';

export interface CreateCategoryInput {
  name: string;
  parentId?: string | null;
}

export interface UpdateCategoryInput {
  name?: string;
  isActive?: boolean;
}

export const CategoryService = {
  list() {
    return prisma.category.findMany({
      orderBy: [{ parentId: 'asc' }, { name: 'asc' }],
    });
  },

  async create(input: CreateCategoryInput) {
    const name = input.name.trim();
    const parentId = input.parentId ?? null;

    if (parentId) {
      const parent = await prisma.category.findUnique({ where: { id: parentId } });
      if (!parent) {
        throw new ValidationError({ parentId: 'Danh mục cha không tồn tại' });
      }
    }

    // Manual dup-name guard scoped to the same parent — Postgres unique
    // indexes treat NULL as distinct, so the schema's `(name, parentId)`
    // unique constraint doesn't block top-level duplicates on its own.
    const dup = await prisma.category.findFirst({ where: { name, parentId } });
    if (dup) {
      throw new ValidationError({ name: 'Tên danh mục đã tồn tại' });
    }

    return prisma.category.create({ data: { name, parentId, isActive: true } });
  },

  async update(id: string, patch: UpdateCategoryInput) {
    const existing = await prisma.category.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Không tìm thấy danh mục');

    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      const dup = await prisma.category.findFirst({
        where: { name: trimmed, parentId: existing.parentId, NOT: { id } },
      });
      if (dup) {
        throw new ValidationError({ name: 'Tên danh mục đã tồn tại' });
      }
    }

    return prisma.category.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      },
    });
  },

  async remove(id: string) {
    const existing = await prisma.category.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Không tìm thấy danh mục');

    const childCount = await prisma.category.count({ where: { parentId: id } });
    if (childCount > 0) {
      throw new ConflictError('Không thể xóa danh mục đang có danh mục con');
    }
    // Note: live-ticket guard (Ticket.categoryId == id) is FP §K open item — Prisma's
    // schema currently sets ticket.categoryId to NULL on delete (onDelete: SetNull).

    await prisma.category.delete({ where: { id } });
  },
};
