import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sanitizeNextPath, upsertGoogleUser } from '../../src/services/AuthService';
import { DisabledAccountError, ForbiddenError } from '../../src/lib/errors';
import { disconnect, resetDb, testPrisma } from '../helpers/test-db';
import { runSeed } from '../../prisma/seed';

const allowed = (suffix = 'newperson') => `${suffix}@ums.edu.vn`;

describe('AuthService — Google OAuth (BE-S12)', () => {
  describe('sanitizeNextPath', () => {
    it('passes through a plain path', () => {
      expect(sanitizeNextPath('/tickets/new')).toBe('/tickets/new');
      expect(sanitizeNextPath('/analytics')).toBe('/analytics');
    });

    it('rejects schemes — open-redirect guard', () => {
      expect(sanitizeNextPath('https://evil.com')).toBe('/');
      expect(sanitizeNextPath('javascript:alert(1)')).toBe('/');
    });

    it('rejects protocol-relative URLs', () => {
      expect(sanitizeNextPath('//evil.com/path')).toBe('/');
    });

    it('rejects paths that do not start with /', () => {
      expect(sanitizeNextPath('tickets/new')).toBe('/');
      expect(sanitizeNextPath('')).toBe('/');
    });

    it('returns "/" for null/undefined', () => {
      expect(sanitizeNextPath(null)).toBe('/');
      expect(sanitizeNextPath(undefined)).toBe('/');
    });
  });

  describe('upsertGoogleUser', () => {
    beforeEach(async () => {
      await resetDb();
      await runSeed(testPrisma);
    });
    afterAll(async () => {
      await disconnect();
    });

    it('M31-BE-S12-X1: rejects an email outside the @ums.edu.vn / @dau.edu.vn allowlist', async () => {
      await expect(
        upsertGoogleUser(testPrisma, {
          googleId: 'g-rando',
          email: 'someone@gmail.com',
          displayName: 'Someone',
          avatarUrl: null,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('M31-BE-S12-H1: creates a new SV user when neither googleId nor email match', async () => {
      const result = await upsertGoogleUser(testPrisma, {
        googleId: 'g-new-1',
        email: allowed('brand-new'),
        displayName: 'Brand New Student',
        avatarUrl: 'https://lh3.googleusercontent.com/a/avatar-1',
      });
      expect(result.role).toBe('SV');
      expect(result.departmentId).toBeNull();
      expect(result.displayName).toBe('Brand New Student');

      const row = await testPrisma.user.findUniqueOrThrow({ where: { id: result.id } });
      expect(row.googleId).toBe('g-new-1');
      expect(row.email).toBe(allowed('brand-new'));
      expect(row.avatarUrl).toBe('https://lh3.googleusercontent.com/a/avatar-1');
      expect(row.ssoSubject).toBe('google:g-new-1');
    });

    it('M31-BE-S12-H2: links by email when a row exists (preserves role + history)', async () => {
      // Seeded persona: sv01@ums.edu.vn (id=u-sv-1, role=SV). Link a Google id to it.
      const result = await upsertGoogleUser(testPrisma, {
        googleId: 'g-link-1',
        email: 'sv01@ums.edu.vn',
        displayName: 'New Display Name From Google',
        avatarUrl: 'https://lh3.googleusercontent.com/a/sv1-avatar',
      });
      expect(result.id).toBe('u-sv-1');
      expect(result.role).toBe('SV');
      // displayName stays as the operator-set one (we don't overwrite from Google here).
      expect(result.displayName).toBe('SV Nguyễn Văn A');

      const row = await testPrisma.user.findUniqueOrThrow({ where: { id: 'u-sv-1' } });
      expect(row.googleId).toBe('g-link-1');
      expect(row.avatarUrl).toBe('https://lh3.googleusercontent.com/a/sv1-avatar');
    });

    it('M31-BE-S12-H3: links a Helpdesk Lead by email without demoting their role', async () => {
      const result = await upsertGoogleUser(testPrisma, {
        googleId: 'g-link-lead',
        email: 'lead01@ums.edu.vn',
        displayName: 'Vũ Văn Hùng (Google)',
        avatarUrl: null,
      });
      expect(result.id).toBe('u-hdl');
      expect(result.role).toBe('HelpdeskLead');
    });

    it('M31-BE-S12-E1: returning Google sign-in refreshes displayName + avatarUrl', async () => {
      const first = await upsertGoogleUser(testPrisma, {
        googleId: 'g-returning',
        email: allowed('returning'),
        displayName: 'Original Name',
        avatarUrl: 'https://example.com/a/old.png',
      });

      const second = await upsertGoogleUser(testPrisma, {
        googleId: 'g-returning',
        email: allowed('returning'),
        displayName: 'Updated Name From Google',
        avatarUrl: 'https://example.com/a/new.png',
      });

      expect(second.id).toBe(first.id);
      expect(second.displayName).toBe('Updated Name From Google');
      const row = await testPrisma.user.findUniqueOrThrow({ where: { id: second.id } });
      expect(row.avatarUrl).toBe('https://example.com/a/new.png');
    });

    it('M31-BE-S12-E2: @dau.edu.vn is also allowlisted', async () => {
      const result = await upsertGoogleUser(testPrisma, {
        googleId: 'g-dau',
        email: 'someone@dau.edu.vn',
        displayName: 'DAU Person',
        avatarUrl: null,
      });
      expect(result.role).toBe('SV');
    });

    it('M31-BE-S12-X2: a DEACTIVATED account matched by googleId cannot sign back in', async () => {
      // First sign-in links the Google id, then Admin soft-deletes the row.
      const first = await upsertGoogleUser(testPrisma, {
        googleId: 'g-disabled',
        email: allowed('disabled-by-id'),
        displayName: 'Will Be Disabled',
        avatarUrl: null,
      });
      await testPrisma.user.update({ where: { id: first.id }, data: { isActive: false } });

      // Re-login via the same googleId must be refused, not silently revived.
      await expect(
        upsertGoogleUser(testPrisma, {
          googleId: 'g-disabled',
          email: allowed('disabled-by-id'),
          displayName: 'Trying Again',
          avatarUrl: null,
        }),
      ).rejects.toBeInstanceOf(DisabledAccountError);
    });

    it('M31-BE-S12-X3: a DEACTIVATED account matched by email cannot sign in via Google', async () => {
      // Seeded persona u-sv-1 (sv01@ums.edu.vn) has no googleId yet. Deactivate it,
      // then a first-time Google sign-in for that email must be refused (would
      // otherwise link + revive a deleted account).
      await testPrisma.user.update({ where: { id: 'u-sv-1' }, data: { isActive: false } });

      await expect(
        upsertGoogleUser(testPrisma, {
          googleId: 'g-email-link',
          email: 'sv01@ums.edu.vn',
          displayName: 'Sneaky Relink',
          avatarUrl: null,
        }),
      ).rejects.toBeInstanceOf(DisabledAccountError);
    });
  });
});
