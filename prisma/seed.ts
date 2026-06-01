import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const DEPARTMENTS = [
  { code: 'CAIRA-IT', name: 'CAIRA / Phòng IT' },
  { code: 'CSVC', name: 'Phòng Quản trị CSVC' },
  { code: 'DT-CTSV', name: 'Phòng Đào tạo / CTSV' },
  { code: 'KT', name: 'Phòng Kế toán' },
  { code: 'HCNS', name: 'Phòng HCNS' },
] as const;

// Top-level categories; `routeTo` is the dept code for the default routing rule.
const CATEGORIES = [
  { name: 'IT / Hệ thống số', routeTo: 'CAIRA-IT' },
  { name: 'Cơ sở vật chất (CSVC)', routeTo: 'CSVC' },
  { name: 'Học vụ / Đào tạo', routeTo: 'DT-CTSV' },
  { name: 'Tài chính', routeTo: 'KT' },
  { name: 'Nhân sự (HCNS)', routeTo: 'HCNS' },
  { name: 'Khác', routeTo: null }, // no default routing — Helpdesk decides
] as const;

export interface SeedCounts {
  departments: number;
  categories: number;
  routingRules: number;
}

/**
 * Idempotent reference-data seed (departments + top-level categories + default
 * routing rules). Re-running is safe — every write is a findFirst+create or
 * upsert keyed on the natural unique column.
 */
export async function runSeed(prisma: PrismaClient): Promise<SeedCounts> {
  for (const d of DEPARTMENTS) {
    await prisma.department.upsert({
      where: { code: d.code },
      create: { code: d.code, name: d.name },
      update: { name: d.name },
    });
  }

  for (const c of CATEGORIES) {
    // (name, parentId=null) is logically unique for top-level categories, but
    // Postgres unique indexes treat NULL as distinct, so we findFirst → create
    // ourselves to stay idempotent.
    const existing = await prisma.category.findFirst({
      where: { name: c.name, parentId: null },
    });
    const cat =
      existing ??
      (await prisma.category.create({
        data: { name: c.name, parentId: null, isActive: true },
      }));

    if (c.routeTo) {
      const dept = await prisma.department.findUnique({ where: { code: c.routeTo } });
      if (dept) {
        await prisma.routingRule.upsert({
          where: {
            categoryId_departmentId: { categoryId: cat.id, departmentId: dept.id },
          },
          create: { categoryId: cat.id, departmentId: dept.id, isDefault: true },
          update: { isDefault: true },
        });
      }
    }
  }

  return {
    departments: await prisma.department.count(),
    categories: await prisma.category.count({ where: { parentId: null } }),
    routingRules: await prisma.routingRule.count(),
  };
}

// CLI entry — runs only when invoked directly (tsx prisma/seed.ts).
const invokedAsScript = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  const prisma = new PrismaClient();
  runSeed(prisma)
    .then((counts) => {
      // eslint-disable-next-line no-console
      console.log(
        `Seed complete — departments: ${counts.departments}, categories: ${counts.categories}, routingRules: ${counts.routingRules}`,
      );
    })
    .catch((e: unknown) => {
      // eslint-disable-next-line no-console
      console.error('Seed failed:', e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
