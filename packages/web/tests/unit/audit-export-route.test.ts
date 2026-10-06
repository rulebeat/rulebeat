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

async function makeUser(email: string, role: AppUser["role"]): Promise<AppUser> {
  const result = await createUser({ email, role });
  if ('error' in result) throw new Error(result.error);
  return result.user;
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

describe('GET /api/audit/export', () => {
  it('rejects an unauthenticated caller', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await exportRoute.GET();
    expect(res.status).toBe(401);
  });

  it('rejects a non-admin caller', async () => {
    const viewer = await makeUser('viewer@example.com', 'viewer');
    mockAuth.mockResolvedValue({ user: { uid: viewer.id } });

    const res = await exportRoute.GET();
    expect(res.status).toBe(403);
  });

  it('returns every row as CSV, beyond the 200-row UI cap, with the right headers', async () => {
    const admin = await makeUser('admin@example.com', 'admin');
    mockAuth.mockResolvedValue({ user: { uid: admin.id } });

    for (let i = 0; i < 205; i++) {
      await writeAudit({ actor: admin, action: 'rule.create', summary: `entry ${i}` });
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
    const admin = await makeUser('admin2@example.com', 'admin');
    mockAuth.mockResolvedValue({ user: { uid: admin.id } });

    await writeAudit({
      actor: admin,
      action: 'rule.create',
      summary: 'A rule named "Cost, and compliance"',
    });

    const res = await exportRoute.GET();
    const body = await res.text();
    expect(body).toContain('"A rule named ""Cost, and compliance"""');
  });

  it('escapes a formula-injection value with a leading apostrophe', async () => {
    const admin = await makeUser('admin3@example.com', 'admin');
    mockAuth.mockResolvedValue({ user: { uid: admin.id } });

    await writeAudit({
      actor: admin,
      action: 'rule.create',
      summary: "=cmd|' /C calc'!A1",
    });

    const res = await exportRoute.GET();
    const body = await res.text();
    expect(body).toContain("'=cmd");
  });

  it('prefixes an apostrophe on every leading formula character, tab and carriage return included', async () => {
    const admin = await makeUser('admin4@example.com', 'admin');
    mockAuth.mockResolvedValue({ user: { uid: admin.id } });

    for (const summary of ['=sum', '+sum', '-sum', '@sum', '\tsum', '\rsum']) {
      await writeAudit({ actor: admin, action: 'rule.create', summary });
    }

    const res = await exportRoute.GET();
    const body = await res.text();
    expect(body).toContain(",'=sum,");
    expect(body).toContain(",'+sum,");
    expect(body).toContain(",'-sum,");
    expect(body).toContain(",'@sum,");
    expect(body).toContain(",'\tsum,");
    // A leading CR also forces quoting, so the guarded cell stays in one row.
    expect(body).toContain(",\"'\rsum\",");
  });

  it('quotes a value holding a bare carriage return so the row cannot split', async () => {
    const admin = await makeUser('admin5@example.com', 'admin');
    mockAuth.mockResolvedValue({ user: { uid: admin.id } });

    await writeAudit({ actor: admin, action: 'rule.create', summary: 'first\rsecond' });

    const res = await exportRoute.GET();
    const body = await res.text();
    expect(body).toContain(',"first\rsecond",');
  });

  it('leaves a value with a formula character only in the middle untouched', async () => {
    const admin = await makeUser('admin6@example.com', 'admin');
    mockAuth.mockResolvedValue({ user: { uid: admin.id } });

    await writeAudit({ actor: admin, action: 'rule.create', summary: 'a=b-c+d@e' });

    const res = await exportRoute.GET();
    const body = await res.text();
    expect(body).toContain(',a=b-c+d@e,');
  });
});
