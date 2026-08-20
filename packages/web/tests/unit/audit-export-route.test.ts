/**
 * Spec 022 — GET /api/audit/export: admin-only, unpaginated CSV, with formula-injection and
 * quote/comma escaping since summary/details are attacker-influenced (rule/resource names).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser, type AppUser } from '@/lib/db/users';
import { writeAudit } from '@/lib/db/audit';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({
  auth: () => mockAuth(),
}));

const exportRoute = await import('@/app/api/audit/export/route');

function makeUser(email: string, role: AppUser['role']): AppUser {
  const result = createUser({ email, role });
  if ('error' in result) throw new Error(result.error);
  return result.user;
}

beforeEach(() => {
  resetDb();
  mockAuth.mockReset();
});

describe('GET /api/audit/export', () => {
  it('rejects an unauthenticated caller', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await exportRoute.GET();
    expect(res.status).toBe(401);
  });

  it('rejects a non-admin caller', async () => {
    const viewer = makeUser('viewer@example.com', 'viewer');
    mockAuth.mockResolvedValue({ user: { uid: viewer.id } });

    const res = await exportRoute.GET();
    expect(res.status).toBe(403);
  });

  it('returns every row as CSV, beyond the 200-row UI cap, with the right headers', async () => {
    const admin = makeUser('admin@example.com', 'admin');
    mockAuth.mockResolvedValue({ user: { uid: admin.id } });

    for (let i = 0; i < 205; i++) {
      writeAudit({ actor: admin, action: 'rule.create', summary: `entry ${i}` });
    }

    const res = await exportRoute.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/csv');
    expect(res.headers.get('Content-Disposition')).toContain('audit-log.csv');

    const body = await res.text();
    const lines = body.trim().split('\n');
    expect(lines[0]).toBe('id,occurredAt,actorEmail,action,entityType,entityId,summary,details');
    expect(lines.length).toBe(206);
  });

  it('quotes a comma/quote-bearing value and doubles embedded quotes', async () => {
    const admin = makeUser('admin2@example.com', 'admin');
    mockAuth.mockResolvedValue({ user: { uid: admin.id } });

    writeAudit({
      actor: admin,
      action: 'rule.create',
      summary: 'A rule named "Cost, and compliance"',
    });

    const res = await exportRoute.GET();
    const body = await res.text();
    expect(body).toContain('"A rule named ""Cost, and compliance"""');
  });

  it('escapes a formula-injection value with a leading apostrophe', async () => {
    const admin = makeUser('admin3@example.com', 'admin');
    mockAuth.mockResolvedValue({ user: { uid: admin.id } });

    writeAudit({
      actor: admin,
      action: 'rule.create',
      summary: "=cmd|' /C calc'!A1",
    });

    const res = await exportRoute.GET();
    const body = await res.text();
    expect(body).toContain("'=cmd");
  });
});
