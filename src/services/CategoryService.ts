import { prisma } from '../lib/prisma.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';

export interface CreateCategoryInput {
  name: string;
}

export interface UpdateCategoryInput {
  name?: string;
  isActive?: boolean;
}

export const CategoryService = {
  async list() {
    const cats = await prisma.category.findMany({ orderBy: { name: 'asc' } });
    // Alphabetical, but pin "Khác" (the catch-all) to the bottom regardless
    // of where its name would land. Match is case-insensitive so a rename to
    // "khác" or "KHÁC" still gets the same treatment.
    const isKhac = (name: string) => name.trim().toLowerCase() === 'khác';
    const head = cats.filter((c) => !isKhac(c.name));
    const tail = cats.filter((c) => isKhac(c.name));
    return [...head, ...tail];
  },

  async create(input: CreateCategoryInput) {
    const name = input.name.trim();

    // Categories are flat (no parent), so name uniqueness is global. Manual
    // guard rather than a DB unique constraint, since legacy seed data may
    // still have collisions and we'd rather surface a 422 than a Prisma error.
    const dup = await prisma.category.findFirst({ where: { name } });
    if (dup) {
      throw new ValidationError({ name: 'Tên danh mục đã tồn tại' });
    }

    return prisma.category.create({ data: { name, isActive: true } });
  },

  async update(id: string, patch: UpdateCategoryInput) {
    const existing = await prisma.category.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Không tìm thấy danh mục');

    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      const dup = await prisma.category.findFirst({
        where: { name: trimmed, NOT: { id } },
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

    // Live-ticket guard isn't enforced here — Prisma's schema sets
    // ticket.categoryId to NULL on delete (onDelete: SetNull).
    await prisma.category.delete({ where: { id } });
  },
};
