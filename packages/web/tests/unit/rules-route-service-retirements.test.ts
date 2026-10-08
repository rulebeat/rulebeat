/**
 * Issue #181: RuleBeat Core ships a "Service retirements" rule as an Advisory with a Deadline and a
 * group column, and an admin can switch it to a Problem. Kind belongs to the install, so only the
 * rule's query is locked, not its kind.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { SERVICE_RETIREMENTS_RULE_ID } from '../helpers/catalogue';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { loadRules } from '@/lib/rules';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
vi.mock('@/lib/azure-credential', () => ({
  createTenantContext: () => Promise.reject(new Error('no credential configured')),
}));

const { PUT } = await import('@/app/api/rules/[id]/route');

const put = (id: string, b: unknown) => PUT(new Request('http://localhost/api/rules/x', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
}), { params: Promise.resolve({ id }) });

async function signInAsAdmin(): Promise<void> {
  const result = await createUser({ email: 'admin@example.com', role: 'admin' });
  if ('error' in result) throw new Error(result.error);
  await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
}

const shipped = async () => (await loadRules()).find(r => r.id === SERVICE_RETIREMENTS_RULE_ID)!;

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  await signInAsAdmin();
});

describe('the shipped Service retirements rule', () => {
  it('is seeded as an enabled Advisory with its Deadline and group columns', async () => {
    const rule = await shipped();
    expect(rule).toBeDefined();
    expect(rule.type).toBe('builtin');
    expect(rule.pack).toBe('rulebeat-core');
    expect(rule.category).toBe('reliability');
    expect(rule.enabled).toBe(true);
    expect([rule.kind, rule.deadlineField, rule.groupField]).toEqual(['advisory', 'retirementDate', 'retirementFeatureName']);
  });

  it('says plainly that Advisor coverage is incomplete and public cloud only, and points at the retirements page', async () => {
    const { description } = await shipped();
    expect(description).toMatch(/incomplete/i);
    expect(description).toMatch(/public cloud/i);
    expect(description).toContain('azure.microsoft.com/updates');
    expect(description).not.toContain('—');
  });

  it('is not locked: an admin can switch it to a Problem, and the query stays as shipped', async () => {
    const before = await shipped();
    const res = await put(before.id, { ...before, kind: 'state' });
    expect(res.status).toBe(200);
    const after = await shipped();
    expect(after.kind).toBe('state');
    expect(after.rawKql).toBe(before.rawKql);
  });

  it('can be switched to a Problem by a body that names only the kind and the enabled toggle', async () => {
    const res = await put(SERVICE_RETIREMENTS_RULE_ID, { enabled: true, kind: 'state' });
    expect(res.status).toBe(200);
    expect((await shipped()).kind).toBe('state');
  });

  it('can be switched back to an Advisory', async () => {
    await put(SERVICE_RETIREMENTS_RULE_ID, { enabled: true, kind: 'state' });
    const res = await put(SERVICE_RETIREMENTS_RULE_ID, { enabled: true, kind: 'advisory' });
    expect(res.status).toBe(200);
    expect((await shipped()).kind).toBe('advisory');
  });
});
