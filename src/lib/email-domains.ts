/**
 * Institutional email domains accepted across the system — for Google SSO
 * sign-in AND Admin-created users. A single source of truth so the two paths
 * can never drift (e.g. SSO accepting a domain that manual-create rejects).
 */
export const ALLOWED_EMAIL_DOMAINS = ['ums.edu.vn', 'dau.edu.vn'] as const;

/** The domain part of an email, lower-cased; '' when there's no `@`. */
export function emailDomain(email: string): string {
  return email.split('@')[1]?.toLowerCase() ?? '';
}

/** True when `email` belongs to an allowed institutional domain. */
export function isAllowedEmailDomain(email: string): boolean {
  return (ALLOWED_EMAIL_DOMAINS as readonly string[]).includes(emailDomain(email));
}

/** Human-readable list for error messages, e.g. "@ums.edu.vn hoặc @dau.edu.vn". */
export const ALLOWED_EMAIL_DOMAINS_LABEL = ALLOWED_EMAIL_DOMAINS.map((d) => `@${d}`).join(' hoặc ');
