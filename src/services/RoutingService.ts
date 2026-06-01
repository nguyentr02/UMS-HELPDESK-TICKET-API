import { prisma } from '../lib/prisma';
import { NotFoundError, ValidationError } from '../lib/errors';

export interface CreateRoutingInput {
  categoryId: string;
  departmentId: string;
  isDefault?: boolean;
}

export interface UpdateRoutingInput {
  departmentId?: string;
  isDefault?: boolean;
}

export const RoutingService = {
  list(query: { categoryId?: string } = {}) {
    return prisma.routingRule.findMany({
      where: query.categoryId ? { categoryId: query.categoryId } : undefined,
      orderBy: [{ categoryId: 'asc' }, { isDefault: 'desc' }],
    });
  },

  async create(input: CreateRoutingInput) {
    const [cat, dept] = await Promise.all([
      prisma.category.findUnique({ where: { id: input.categoryId } }),
      prisma.department.findUnique({ where: { id: input.departmentId } }),
    ]);
    if (!cat) throw new ValidationError({ categoryId: 'Danh mục không tồn tại' });
    if (!dept) throw new ValidationError({ departmentId: 'Phòng ban không tồn tại' });

    const dup = await prisma.routingRule.findUnique({
      where: {
        categoryId_departmentId: {
          categoryId: input.categoryId,
          departmentId: input.departmentId,
        },
      },
    });
    if (dup) {
      throw new ValidationError({ _: 'Quy tắc định tuyến đã tồn tại' });
    }

    // Single tx: if this rule is the new default, unset any prior default for
    // the same category before inserting — guarantees at most one default.
    return prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.routingRule.updateMany({
          where: { categoryId: input.categoryId, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.routingRule.create({
        data: {
          categoryId: input.categoryId,
          departmentId: input.departmentId,
          isDefault: input.isDefault ?? false,
        },
      });
    });
  },

  async update(id: string, patch: UpdateRoutingInput) {
    const existing = await prisma.routingRule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Không tìm thấy quy tắc định tuyến');

    if (patch.departmentId !== undefined) {
      const dept = await prisma.department.findUnique({ where: { id: patch.departmentId } });
      if (!dept) throw new ValidationError({ departmentId: 'Phòng ban không tồn tại' });
    }

    return prisma.$transaction(async (tx) => {
      if (patch.isDefault === true) {
        await tx.routingRule.updateMany({
          where: { categoryId: existing.categoryId, isDefault: true, NOT: { id } },
          data: { isDefault: false },
        });
      }
      return tx.routingRule.update({
        where: { id },
        data: {
          ...(patch.departmentId !== undefined ? { departmentId: patch.departmentId } : {}),
          ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
        },
      });
    });
  },

  async remove(id: string) {
    const existing = await prisma.routingRule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Không tìm thấy quy tắc định tuyến');
    await prisma.routingRule.delete({ where: { id } });
  },
};
