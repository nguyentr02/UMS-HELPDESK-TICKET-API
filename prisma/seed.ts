import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const DEPARTMENTS = [
  { code: 'CAIRA-IT', name: 'CAIRA / Phòng IT' },
  { code: 'CSVC', name: 'Phòng Quản trị CSVC' },
  { code: 'DT-CTSV', name: 'Phòng Đào tạo / CTSV' },
  { code: 'KT', name: 'Phòng Kế toán' },
  { code: 'HCNS', name: 'Phòng HCNS' },
] as const;

// Flat list of triage categories — there's no parent/child hierarchy and no
// auto-routing (Agent/Lead picks the department per ticket).
const CATEGORIES = [
  { name: 'IT / Hệ thống số' },
  { name: 'Cơ sở vật chất (CSVC)' },
  { name: 'Học vụ / Đào tạo' },
  { name: 'Tài chính' },
  { name: 'Nhân sự (HCNS)' },
  { name: 'Khác' },
] as const;

// Demo personas (mirrors FE `mocks/personas.ts` — keep in sync). Each row gets a
// realistic email + plain password; the password is bcrypt-hashed on seed.
// `deptCode` is resolved to the real cuid at seed time.
type Role = 'SV' | 'GV' | 'NV' | 'HelpdeskLead' | 'HelpdeskAgent' | 'DeptStaff' | 'Admin';

export interface PersonaSeed {
  id: string;
  email: string;
  password: string;
  displayName: string;
  role: Role;
  deptCode: string | null;
}

export const PERSONAS: PersonaSeed[] = [
  // Sinh viên
  { id: 'u-sv-1',  email: 'sv01@ums.edu.vn',           password: 'sv01-demo!',         displayName: 'SV Nguyễn Văn A',          role: 'SV',            deptCode: null      },
  { id: 'u-sv-2',  email: 'sv02@ums.edu.vn',           password: 'sv02-demo!',         displayName: 'SV Phạm Thị D',            role: 'SV',            deptCode: null      },
  // Giảng viên
  { id: 'u-gv-1',  email: 'gv01@ums.edu.vn',           password: 'gv01-demo!',         displayName: 'GV Trần Văn B',            role: 'GV',            deptCode: null      },
  { id: 'u-gv-2',  email: 'gv02@ums.edu.vn',           password: 'gv02-demo!',         displayName: 'GV Hoàng Văn E',           role: 'GV',            deptCode: null      },
  // Nhân viên
  { id: 'u-nv-1',  email: 'nv01@ums.edu.vn',           password: 'nv01-demo!',         displayName: 'NV Lê Văn C',              role: 'NV',            deptCode: null      },
  { id: 'u-nv-2',  email: 'nv02@ums.edu.vn',           password: 'nv02-demo!',         displayName: 'NV Bùi Thị F',             role: 'NV',            deptCode: null      },
  // Helpdesk Agent
  { id: 'u-hda',   email: 'agent01@ums.edu.vn',        password: 'agent01-demo!',      displayName: 'Đỗ Thị Mai',               role: 'HelpdeskAgent', deptCode: null      },
  { id: 'u-hda-2', email: 'agent02@ums.edu.vn',        password: 'agent02-demo!',      displayName: 'Nguyễn Văn Quân',          role: 'HelpdeskAgent', deptCode: null      },
  // Helpdesk Lead
  { id: 'u-hdl',   email: 'lead01@ums.edu.vn',         password: 'lead01-demo!',       displayName: 'Vũ Văn Hùng',              role: 'HelpdeskLead',  deptCode: null      },
  // Dept Staff (per-department)
  { id: 'u-staff',        email: 'staff.csvc@ums.edu.vn', password: 'staff-csvc-demo!', displayName: 'Phan Thị Hương (CSVC)',    role: 'DeptStaff',     deptCode: 'CSVC'    },
  { id: 'u-staff-hcns',   email: 'staff.hcns@ums.edu.vn', password: 'staff-hcns-demo!', displayName: 'Lương Văn Đức (HCNS)',     role: 'DeptStaff',     deptCode: 'HCNS'    },
  { id: 'u-staff-dt',     email: 'staff.dt@ums.edu.vn',   password: 'staff-dt-demo!',   displayName: 'Trịnh Thị Lan (Đào tạo)',  role: 'DeptStaff',     deptCode: 'DT-CTSV' },
  // Admin
  { id: 'u-admin', email: 'admin@ums.edu.vn',          password: 'admin-demo!',        displayName: 'Quản trị viên',            role: 'Admin',         deptCode: null      },
];

export interface SeedCounts {
  departments: number;
  categories: number;
  users: number;
}

/** Idempotent reference-data seed: departments + flat categories + demo personas with bcrypt-hashed passwords. */
export async function runSeed(prisma: PrismaClient): Promise<SeedCounts> {
  for (const d of DEPARTMENTS) {
    await prisma.department.upsert({
      where: { code: d.code },
      create: { code: d.code, name: d.name },
      update: { name: d.name },
    });
  }

  for (const c of CATEGORIES) {
    const existing = await prisma.category.findFirst({ where: { name: c.name } });
    if (!existing) {
      await prisma.category.create({ data: { name: c.name, isActive: true } });
    }
  }

  // ─── Demo personas (email + bcrypt-hashed password) ───
  const deptRows = await prisma.department.findMany({ select: { id: true, code: true } });
  const deptByCode = new Map(deptRows.map((d) => [d.code, d.id]));
  for (const u of PERSONAS) {
    const departmentId = u.deptCode ? deptByCode.get(u.deptCode) ?? null : null;
    const passwordHash = await bcrypt.hash(u.password, 10);
    await prisma.user.upsert({
      where: { id: u.id },
      create: {
        id: u.id,
        ssoSubject: `mock:${u.id}`,
        email: u.email,
        passwordHash,
        displayName: u.displayName,
        role: u.role,
        departmentId,
      },
      update: {
        email: u.email,
        passwordHash,
        displayName: u.displayName,
        role: u.role,
        departmentId,
      },
    });
  }

  return {
    departments: await prisma.department.count(),
    categories: await prisma.category.count(),
    users: await prisma.user.count(),
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
        `Seed complete — departments: ${counts.departments}, categories: ${counts.categories}, users: ${counts.users}`,
      );
    })
    .catch((e: unknown) => {
      // eslint-disable-next-line no-console
      console.error('Seed failed:', e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
