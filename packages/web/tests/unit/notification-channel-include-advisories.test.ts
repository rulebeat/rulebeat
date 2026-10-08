/**
 * Issue #180: each notification channel has an "Include advisories" setting, off by default. It is
 * stored on the channel, readable and writable through /api/settings/notifications, and a change
 * is audited by field name like every other channel edit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { listAllAuditEntries } from '@/lib/db/audit';
import { createChannel, deleteChannel, getChannelSummary, getStoredChannel, listChannels } from '@/lib/db/notification-channels';
import { setDnsLookupForTests } from '@/lib/ssrf-guard';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const { GET, POST, PUT } = await import('@/app/api/settings/notifications/route');

const URL_ = 'http://localhost/api/settings/notifications';
const EMAIL_CONFIG = {
  host: '93.184.216.34', port: 587, tls: 'starttls' as const, username: 'ops',
  fromAddress: 'rulebeat@example.com', toAddresses: 'a@example.com, b@example.com',
};

function req(method: string, body: unknown): Request {
  return new Request(URL_, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function signInAs(role: 'admin' | 'viewer'): Promise<void> {
  const result = await createUser({ email: `${role}@example.com`, role });
  if ('error' in result) throw new Error(result.error);
  await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
}

async function auditFields(action: string): Promise<string[]> {
  const entry = (await listAllAuditEntries()).find(e => e.action === action);
  return (entry?.details as { fields?: string[] } | undefined)?.fields ?? [];
}

describe('notification channel "Include advisories" setting', () => {
  beforeEach(async () => {
    await resetDb();
    // resetDb leaves channels alone; this suite counts and lists them.
    for (const channel of await listChannels()) await deleteChannel(channel.id);
    mockAuth.mockReset();
    await signInAs('admin');
    setDnsLookupForTests(async () => [{ address: '93.184.216.34' }]);
  });

  it('is off for a channel created without saying', async () => {
    const created = await createChannel({ name: 'Plain', type: 'webhook', url: 'https://93.184.216.34/hook' });

    expect(created.includeAdvisories).toBe(false);
    expect((await getStoredChannel(created.id))!.includeAdvisories).toBe(false);
  });

  it('POST stores the setting when it is on and reports it back', async () => {
    const res = await POST(req('POST', { name: 'Advisory feed', type: 'webhook', url: 'https://93.184.216.34/hook', includeAdvisories: true }));

    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.includeAdvisories).toBe(true);
    expect((await getChannelSummary(created.id))!.includeAdvisories).toBe(true);
    expect(await auditFields('notification_channel.create')).toContain('includeAdvisories');
  });

  it('POST without the setting leaves it off', async () => {
    const res = await POST(req('POST', { name: 'Quiet', type: 'webhook', url: 'https://93.184.216.34/hook' }));

    expect((await res.json()).includeAdvisories).toBe(false);
    expect(await auditFields('notification_channel.create')).not.toContain('includeAdvisories');
  });

  it('PUT flips the setting on and off, audited by field name, and keeps the rest of the config', async () => {
    const channel = await createChannel({ name: 'Mail', type: 'email', url: 'smtp-password', config: EMAIL_CONFIG });

    const on = await PUT(req('PUT', { id: channel.id, includeAdvisories: true }));
    expect(on.status).toBe(200);
    expect((await on.json()).includeAdvisories).toBe(true);
    expect(await auditFields('notification_channel.update')).toEqual(['includeAdvisories']);
    const kept = await getStoredChannel(channel.id);
    expect(kept!.includeAdvisories).toBe(true);
    expect(kept!.emailConfig).toEqual(EMAIL_CONFIG);
    expect(kept!.url).toBe('smtp-password');
    expect(kept!.name).toBe('Mail');

    const off = await PUT(req('PUT', { id: channel.id, includeAdvisories: false }));
    expect((await off.json()).includeAdvisories).toBe(false);
  });

  it('PUT that does not mention the setting leaves it as it was', async () => {
    const channel = await createChannel({ name: 'Keeps', type: 'webhook', url: 'https://93.184.216.34/hook', includeAdvisories: true });

    await PUT(req('PUT', { id: channel.id, name: 'Renamed' }));

    expect((await getChannelSummary(channel.id))!.includeAdvisories).toBe(true);
  });

  it('rejects a setting that is not a boolean, on create and on update', async () => {
    const channel = await createChannel({ name: 'Strict', type: 'webhook', url: 'https://93.184.216.34/hook' });

    const create = await POST(req('POST', { name: 'Bad', type: 'webhook', url: 'https://93.184.216.34/hook', includeAdvisories: 'yes' }));
    const update = await PUT(req('PUT', { id: channel.id, includeAdvisories: 1 }));

    expect(create.status).toBe(400);
    expect(update.status).toBe(400);
    expect(await listChannels()).toHaveLength(1);
    expect((await getChannelSummary(channel.id))!.includeAdvisories).toBe(false);
  });

  it('GET lists the setting for every channel', async () => {
    await createChannel({ name: 'On', type: 'webhook', url: 'https://93.184.216.34/a', includeAdvisories: true });
    await createChannel({ name: 'Off', type: 'webhook', url: 'https://93.184.216.34/b' });

    const listed = (await (await GET()).json()) as { name: string; includeAdvisories: boolean }[];

    expect(Object.fromEntries(listed.map(c => [c.name, c.includeAdvisories]))).toEqual({ On: true, Off: false });
  });
});
