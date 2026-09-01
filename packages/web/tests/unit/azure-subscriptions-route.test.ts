/**
 * GET /api/azure/subscriptions feeds a background name lookup (`useSubscriptionNames`) that every
 * page with a subscription filter fires on load, whether or not Azure has been connected yet. It
 * must not turn "not configured" into a page-load error — see the route's own comment.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { AzureNotConfiguredError } from '@/lib/azure-credential';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

let fail: Error | null;
vi.mock('@/lib/arm', () => ({
  getArmCredential: () => {
    if (fail) throw fail;
    return {};
  },
}));
vi.mock('@azure/arm-resources-subscriptions', () => ({
  SubscriptionClient: class {
    subscriptions = {
      list: async function* () {
        yield { subscriptionId: 'sub-1', displayName: 'Sub One', state: 'Enabled' };
      },
    };
  },
}));

const { GET } = await import('@/app/api/azure/subscriptions/route');

async function signInAsViewer(): Promise<void> {
  const result = await createUser({ email: 'viewer@example.com', role: 'viewer' });
  if ('error' in result) throw new Error(result.error);
  await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
}

describe('GET /api/azure/subscriptions', () => {
  beforeEach(async () => {
    await resetDb();
    mockAuth.mockReset();
    fail = null;
    await signInAsViewer();
  });

  it('returns 200 with an empty list when Azure has never been configured', async () => {
    fail = new AzureNotConfiguredError('RuleBeat has no Azure credential to scan with.');
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([]);
  });

  it('still returns a generic 500 for a genuine Azure failure', async () => {
    fail = new Error('ECONNRESET');
    const res = await GET();
    expect(res.status).toBe(500);
  });

  it('returns the subscription list on success', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([{ id: 'sub-1', name: 'Sub One' }]);
  });
});
