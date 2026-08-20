import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { provisionUser } from '@/lib/provision-user';
import { createUser, deleteUser, getUserByEmail } from '@/lib/db/users';
import { listAuditEntries } from '@/lib/db/audit';

beforeEach(() => {
  resetDb();
});

describe('provisionUser — deny by default', () => {
  it('denies an unknown oid/email when an admin exists, and logs (not persists) the attempt (spec 022)', () => {
    const admin = createUser({ email: 'admin@example.com', role: 'admin' });
    if ('error' in admin) throw new Error(admin.error);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = provisionUser({ oid: 'oid-stranger', email: 'stranger@example.com', name: 'Stranger' });

      expect(result).toBeNull();
      expect(getUserByEmail('stranger@example.com')).toBeNull();

      // Denied Entra sign-ins are unbounded — reachable by anyone who can complete a sign-in
      // against the tenant, provisioned or not — so this is logged to stdout, never persisted
      // to audit_log (spec 022). Persisting it would let an attacker grow the table without limit.
      expect(logSpy).toHaveBeenCalled();
      const payload = JSON.parse(logSpy.mock.calls[0]![0] as string);
      expect(payload.message).toContain('stranger@example.com');
      expect(payload.reason).toBe('not-provisioned');
      expect(payload.oid).toBe('oid-stranger');

      const entries = listAuditEntries();
      expect(entries.find(e => e.action === 'auth.sign_in_failed')).toBeUndefined();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('still denies an unknown oid/email when zero admins exist — no bootstrap exception', () => {
    expect(getUserByEmail('nobody-yet@example.com')).toBeNull();

    const result = provisionUser({ oid: 'oid-first-ever', email: 'nobody-yet@example.com' });

    expect(result).toBeNull();
    expect(getUserByEmail('nobody-yet@example.com')).toBeNull();
  });

  it('binds the oid and succeeds when a row was pre-created by email (invite flow)', () => {
    const invited = createUser({ email: 'invited@example.com', role: 'editor' });
    if ('error' in invited) throw new Error(invited.error);
    expect(invited.user.oid).toBeNull();

    const result = provisionUser({ oid: 'oid-invited', email: 'invited@example.com', name: 'Invited Person' });

    expect(result?.id).toBe(invited.user.id);
    expect(result?.role).toBe('editor');
    expect(getUserByEmail('invited@example.com')?.oid).toBe('oid-invited');
  });

  it('denies a deleted user on their next sign-in — deletion is durable revocation', () => {
    const admin = createUser({ email: 'admin2@example.com', role: 'admin' });
    if ('error' in admin) throw new Error(admin.error);
    const removed = createUser({ email: 'removed@example.com', role: 'viewer', oid: 'oid-removed' });
    if ('error' in removed) throw new Error(removed.error);

    const before = deleteUser(removed.user.id);
    expect(before).toBe(true);

    const result = provisionUser({ oid: 'oid-removed', email: 'removed@example.com' });

    expect(result).toBeNull();
    expect(getUserByEmail('removed@example.com')).toBeNull();
  });

  it('a known oid resolves normally, unaffected by the deny-by-default path', () => {
    const known = createUser({ email: 'known@example.com', role: 'viewer', oid: 'oid-known' });
    if ('error' in known) throw new Error(known.error);

    const result = provisionUser({ oid: 'oid-known', email: 'known@example.com', name: 'Known Person' });

    expect(result?.id).toBe(known.user.id);
    expect(result?.role).toBe('viewer');
  });
});

describe('provisionUser — invite-claim audit visibility (spec 019)', () => {
  it('writes exactly one user.invite_claimed entry, plus the usual auth.sign_in, when a pre-invited row is claimed', () => {
    const invited = createUser({ email: 'claimant@example.com', role: 'editor' });
    if ('error' in invited) throw new Error(invited.error);

    const result = provisionUser({ oid: 'oid-claimant', email: 'claimant@example.com', name: 'Claimant' });
    expect(result?.id).toBe(invited.user.id);

    const entries = listAuditEntries();
    const claims = entries.filter(e => e.action === 'user.invite_claimed');
    expect(claims).toHaveLength(1);
    expect(claims[0].entityId).toBe(invited.user.id);
    expect(claims[0].details).toMatchObject({ oid: 'oid-claimant' });
    expect(claims[0].summary).toContain('claimant@example.com');

    expect(entries.some(e => e.action === 'auth.sign_in' && e.entityType === 'auth')).toBe(true);
  });

  it('writes zero user.invite_claimed entries for a returning user (known oid, not a claim)', () => {
    const known = createUser({ email: 'returning@example.com', role: 'viewer', oid: 'oid-returning' });
    if ('error' in known) throw new Error(known.error);

    provisionUser({ oid: 'oid-returning', email: 'returning@example.com', name: 'Returning' });

    const claims = listAuditEntries().filter(e => e.action === 'user.invite_claimed');
    expect(claims).toHaveLength(0);
  });
});
