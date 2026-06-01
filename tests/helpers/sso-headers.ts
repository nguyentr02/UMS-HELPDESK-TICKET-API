import type { Role } from '@/middleware/auth';

export interface MockUser {
  id: string;
  role: Role;
  departmentId?: string | null;
}

const DEFAULT: MockUser = { id: 'u-test', role: 'SV', departmentId: null };

/** Builds the dev SSO headers consumed by `authMiddleware` in mock mode. */
export function mockSsoHeaders(user: MockUser = DEFAULT): Record<string, string> {
  const headers: Record<string, string> = {
    'x-mock-user-id': user.id,
    'x-mock-role': user.role,
  };
  if (user.departmentId) headers['x-mock-dept-id'] = user.departmentId;
  return headers;
}
