/**
 * Spec 021 — POST/PUT /api/settings/notifications and POST /api/settings/notifications/test must
 * reject a destination that resolves to a private/link-local/loopback address (SSRF hardening),
 * both for new channels and for unsaved values typed into the "send test" form. A PUT that only
 * changes the name (no url/config in the body) must be unaffected — the guard only runs when a
 * destination is actually present in the request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { createChannel, getChannelSummary } from '@/lib/db/notification-channels';
import { setDnsLookupForTests, resetDnsLookupForTests } from '@/lib/ssrf-guard';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const { POST, PUT } = await import('@/app/api/settings/notifications/route');
const { POST: TEST_POST } = await import('@/app/api/settings/notifications/test/route');

function req(url: string, method: string, body: unknown): Request {
  return new Request(url, { method, body: JSON.stringify(body) });
}

async function signInAsAdmin(): Promise<void> {
  const result = createUser({ email: 'admin@example.com', role: 'admin' });
  if ('error' in result) throw new Error(result.error);
  setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
}

describe('notification channel routes — SSRF hardening (spec 021)', () => {
  beforeEach(async () => {
    resetDb();
    mockAuth.mockReset();
    await signInAsAdmin();
    // literal public IP used for the "unaffected" case below needs no resolver, but keep a safe
    // default in place in case any code path resolves a hostname.
    setDnsLookupForTests(async () => [{ address: '93.184.216.34' }]);
  });

  afterEach(() => {
    resetDnsLookupForTests();
  });

  it('POST rejects a webhook channel pointed at a private address', async () => {
    const res = await POST(req('http://localhost/api/settings/notifications', 'POST', {
      name: 'Metadata probe',
      type: 'webhook',
      url: 'http://169.254.169.254/latest/meta-data/',
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/not a public address/i);
  });

  it('POST rejects an email channel whose SMTP host is a private address', async () => {
    const res = await POST(req('http://localhost/api/settings/notifications', 'POST', {
      name: 'Internal relay',
      type: 'email',
      config: {
        host: '10.0.0.5',
        port: 25,
        tls: 'none',
        username: '',
        fromAddress: 'alerts@example.com',
        toAddresses: 'ops@example.com',
      },
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/SMTP host is not allowed/i);
  });

  it('PUT rejects updating a channel\'s url to a private address, leaving it unchanged', async () => {
    const channel = createChannel({ name: 'Real webhook', type: 'webhook', url: 'https://93.184.216.34/hook' });

    const res = await PUT(req('http://localhost/api/settings/notifications', 'PUT', {
      id: channel.id,
      url: 'http://127.0.0.1:8080/admin',
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/not a public address/i);

    const stored = getChannelSummary(channel.id);
    expect(stored?.urlHost).toBe('93.184.216.34');
  });

  it('PUT with only a name change is unaffected by the guard', async () => {
    const channel = createChannel({ name: 'Real webhook', type: 'webhook', url: 'https://93.184.216.34/hook' });

    const res = await PUT(req('http://localhost/api/settings/notifications', 'PUT', {
      id: channel.id,
      name: 'Renamed webhook',
    }));
    expect(res.status).toBe(200);
    const stored = getChannelSummary(channel.id);
    expect(stored?.name).toBe('Renamed webhook');
    expect(stored?.urlHost).toBe('93.184.216.34');
  });

  it('POST /test rejects an unsaved private-address webhook value', async () => {
    const res = await TEST_POST(req('http://localhost/api/settings/notifications/test', 'POST', {
      type: 'webhook',
      url: 'http://169.254.169.254/latest/meta-data/',
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/not a public address/i);
  });

  it('POST /test rejects an unsaved private-address SMTP host', async () => {
    const res = await TEST_POST(req('http://localhost/api/settings/notifications/test', 'POST', {
      type: 'email',
      config: {
        host: '172.16.0.9',
        port: 25,
        tls: 'none',
        username: '',
        fromAddress: 'alerts@example.com',
        toAddresses: 'ops@example.com',
      },
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/SMTP host is not allowed/i);
  });
});
