/**
 * The shared notification send path connects only to an address that passed the public-address
 * check, and checks every connection it makes. These tests use the real transport against local
 * servers on 127.0.0.1, which the guard is told to treat as public for the test; none of the
 * hostnames below exist in DNS, so only a connection to the address the resolver returned can
 * reach the server.
 */
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { createChannel, type EmailChannelConfig } from '@/lib/db/notification-channels';
import { deleteLinksForSchedule, setLinksForSchedule } from '@/lib/db/schedule-notification-channels';
import { listDeliveriesForChannel } from '@/lib/db/notification-deliveries';
import { allowAddressesForTests, setDnsLookupForTests, resetDnsLookupForTests, SsrfGuardError } from '@/lib/ssrf-guard';
import type { ScheduleRun } from '@/lib/schedule-runs';
import type { Finding } from '@/lib/types';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const { dispatchNotifications } = await import('@/lib/notifications/dispatch');
const { sendSmtpMail } = await import('@/lib/notifications/send');
const { POST: TEST_POST } = await import('@/app/api/settings/notifications/test/route');

/** Answers 127.0.0.1 on the first resolution and a metadata address on every later one. */
function rebindingLookup() {
  const answers = [[{ address: '127.0.0.1' }], [{ address: '169.254.169.254' }]];
  let call = 0;
  return vi.fn(async () => answers[Math.min(call++, answers.length - 1)]);
}

interface Seen { host: string | undefined; contentType: string | undefined; body: string }

async function startWebhookServer(respond: (res: http.ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ host: req.headers.host, contentType: req.headers['content-type'], body });
      respond(res);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const stop = async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  return { seen, port, stop };
}

/** A minimal SMTP server: accepts one message and keeps the lines of its DATA section. */
async function startSmtpServer() {
  const data: string[] = [];
  let connections = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('220 test ESMTP\r\n');
    let buf = '';
    let inData = false;
    socket.on('data', chunk => {
      buf += chunk.toString();
      let end: number;
      while ((end = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, end);
        buf = buf.slice(end + 2);
        if (inData) {
          if (line === '.') { inData = false; socket.write('250 queued\r\n'); } else data.push(line);
          continue;
        }
        const command = line.slice(0, 4).toUpperCase();
        if (command === 'DATA') { inData = true; socket.write('354 go\r\n'); }
        else if (command === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const stop = async () => {
    sockets.forEach(socket => socket.destroy());
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  return { data, port, connections: () => connections, stop };
}

function smtpConfig(host: string, port: number): EmailChannelConfig {
  return { host, port, tls: 'none', username: '', fromAddress: 'alerts@example.com', toAddresses: 'ops@example.com' };
}

afterEach(() => {
  resetDnsLookupForTests();
  vi.restoreAllMocks();
});

describe('sendSmtpMail', () => {
  let smtp: Awaited<ReturnType<typeof startSmtpServer>>;

  beforeEach(async () => {
    smtp = await startSmtpServer();
    allowAddressesForTests(['127.0.0.1']);
  });

  afterEach(async () => {
    await smtp.stop();
  });

  it('connects to the address it resolved, once, and the message arrives', async () => {
    const lookup = rebindingLookup();
    setDnsLookupForTests(lookup);

    await sendSmtpMail(smtpConfig('smtp.example.test', smtp.port), '', { subject: 'Pinned subject', text: 'Pinned body' });

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(smtp.connections()).toBe(1);
    expect(smtp.data).toContain('Subject: Pinned subject');
    expect(smtp.data).toContain('Pinned body');
  });

  it('hands the mail client the checked address as host and keeps the name for TLS', async () => {
    setDnsLookupForTests(rebindingLookup());
    const { default: nodemailer } = await import('nodemailer');
    const createTransport = vi.spyOn(nodemailer, 'createTransport');

    await sendSmtpMail(smtpConfig('smtp.example.test', smtp.port), '', { subject: 's', text: 't' });

    expect(createTransport.mock.calls[0][0]).toMatchObject({
      host: '127.0.0.1',
      port: smtp.port,
      tls: { servername: 'smtp.example.test' },
    });
  });

  it('sets no TLS server name when the host is already an IP address', async () => {
    const { default: nodemailer } = await import('nodemailer');
    const createTransport = vi.spyOn(nodemailer, 'createTransport');

    await sendSmtpMail(smtpConfig('127.0.0.1', smtp.port), '', { subject: 's', text: 't' });

    expect(createTransport.mock.calls[0][0]).toMatchObject({ host: '127.0.0.1' });
    expect((createTransport.mock.calls[0][0] as { tls?: unknown }).tls).toBeUndefined();
  });

  it('refuses a host that resolves to a private address and never connects', async () => {
    setDnsLookupForTests(async () => [{ address: '10.0.0.5' }]);

    const sent = sendSmtpMail(smtpConfig('relay.example.test', smtp.port), '', { subject: 's', text: 't' });

    await expect(sent).rejects.toThrow('SMTP host is not allowed: relay.example.test resolves to 10.0.0.5, which is not a public address.');
    await expect(sent).rejects.toBeInstanceOf(SsrfGuardError);
    expect(smtp.connections()).toBe(0);
  });

  it('resolves once per send and checks each send on its own', async () => {
    // The first answer is the allowed test address and every later one is private, so the first
    // send succeeding proves nothing resolved again, and the second being refused proves it was checked.
    setDnsLookupForTests(rebindingLookup());

    await expect(sendSmtpMail(smtpConfig('smtp.example.test', smtp.port), '', { subject: 's', text: 't' }))
      .resolves.toBeUndefined();
    await expect(sendSmtpMail(smtpConfig('smtp.example.test', smtp.port), '', { subject: 's', text: 't' }))
      .rejects.toThrow('not a public address');
    expect(smtp.connections()).toBe(1);
  });
});

function makeRun(scheduleId: string): ScheduleRun {
  return {
    id: 'run-1', scheduleId, triggeredBy: 'schedule', targetType: null, targetValues: [],
    startedAt: new Date().toISOString(), finishedAt: null, status: 'running', categories: [],
    totalFindings: 1, newFindings: 1, newFindingFingerprints: [], error: null, durationMs: null,
    notifyStatus: 'pending', notifyClaimedAt: null, heartbeatAt: null, ownerId: null,
  };
}

function makeFinding(): Finding {
  return {
    module: 'test', ruleId: 'rule-1', fingerprint: 'fp-1', severity: 'critical', category: 'security',
    resourceId: '/subscriptions/x/resourceGroups/y/providers/Microsoft.Compute/virtualMachines/vm1',
    resourceType: 'Microsoft.Compute/virtualMachines', resourceName: 'vm1', subscriptionId: 'sub-1',
    title: 'Test finding', description: 'desc', evidence: {}, recommendation: 'fix it',
    remediationSteps: [], detectedAt: new Date().toISOString(),
  };
}

describe('dispatchNotifications through the real send path', () => {
  let scheduleId: string;
  let channelId: string;
  let hook: Awaited<ReturnType<typeof startWebhookServer>>;
  let respond: (res: http.ServerResponse) => void;

  beforeEach(async () => {
    await resetDb();
    respond = res => { res.statusCode = 200; res.end('ok'); };
    hook = await startWebhookServer(res => respond(res));
    scheduleId = `sched-${globalThis.crypto.randomUUID()}`;
    channelId = (await createChannel({ name: 'Hook', type: 'webhook', url: `http://hook.example.test:${hook.port}/in` })).id;
    await setLinksForSchedule(scheduleId, [{ channelId, minSeverity: 'low', categoryIds: null, subscriptionIds: null }]);
    allowAddressesForTests(['127.0.0.1']);
  });

  afterEach(async () => {
    await deleteLinksForSchedule(scheduleId);
    await hook.stop();
  });

  it('delivers a JSON POST to the resolved address, with the channel hostname as Host', async () => {
    setDnsLookupForTests(async () => [{ address: '127.0.0.1' }]);

    await dispatchNotifications(makeRun(scheduleId), [makeFinding()]);

    expect(hook.seen).toHaveLength(1);
    expect(hook.seen[0].host).toBe(`hook.example.test:${hook.port}`);
    expect(hook.seen[0].contentType).toBe('application/json');
    expect(() => JSON.parse(hook.seen[0].body)).not.toThrow();
    const history = await listDeliveriesForChannel(channelId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ ok: true, attempts: 1, httpStatus: 200, error: null });
  });

  it('checks the retry as its own connection: an answer that turned private is refused, not retried', async () => {
    respond = res => { res.statusCode = 503; res.end('busy'); };
    const lookup = rebindingLookup();
    setDnsLookupForTests(lookup);

    await dispatchNotifications(makeRun(scheduleId), [makeFinding()]);

    expect(hook.seen).toHaveLength(1);
    expect(lookup).toHaveBeenCalledTimes(2);
    const history = await listDeliveriesForChannel(channelId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ ok: false, attempts: 2, httpStatus: null });
    expect(history[0].error).toBe('hook.example.test resolves to 169.254.169.254, which is not a public address.');
  }, 15_000);
});

describe('"Send test" through the real send path', () => {
  let hook: Awaited<ReturnType<typeof startWebhookServer>>;
  let respond: (res: http.ServerResponse) => void;

  function testRequest(body: unknown): Request {
    return new Request('http://localhost/api/settings/notifications/test', { method: 'POST', body: JSON.stringify(body) });
  }

  beforeEach(async () => {
    await resetDb();
    mockAuth.mockReset();
    const result = await createUser({ email: 'admin@example.com', role: 'admin' });
    if ('error' in result) throw new Error(result.error);
    await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
    mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
    respond = res => { res.statusCode = 200; res.end('ok'); };
    hook = await startWebhookServer(res => respond(res));
    allowAddressesForTests(['127.0.0.1']);
  });

  afterEach(async () => {
    await hook.stop();
  });

  it('reaches the resolved address and answers ok', async () => {
    setDnsLookupForTests(async () => [{ address: '127.0.0.1' }]);

    const res = await TEST_POST(testRequest({ type: 'webhook', url: `http://hook.example.test:${hook.port}/in` }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(hook.seen).toHaveLength(1);
    expect(hook.seen[0].contentType).toBe('application/json');
  });

  it('reports the receiver\'s status and body when it answers with an error', async () => {
    setDnsLookupForTests(async () => [{ address: '127.0.0.1' }]);
    respond = res => { res.statusCode = 500; res.end('receiver exploded'); };

    const res = await TEST_POST(testRequest({ type: 'webhook', url: `http://hook.example.test:${hook.port}/in` }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'HTTP 500: receiver exploded' });
  });

  it('refuses a destination whose answer is private, without connecting', async () => {
    setDnsLookupForTests(async () => [{ address: '10.1.2.3' }]);

    const res = await TEST_POST(testRequest({ type: 'webhook', url: `http://hook.example.test:${hook.port}/in` }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'hook.example.test resolves to 10.1.2.3, which is not a public address.',
    });
    expect(hook.seen).toHaveLength(0);
  });

  it('refuses a redirect from the receiver', async () => {
    setDnsLookupForTests(async () => [{ address: '127.0.0.1' }]);
    respond = res => { res.statusCode = 307; res.setHeader('Location', 'http://169.254.169.254/'); res.end(); };
    const url = `http://hook.example.test:${hook.port}/in`;

    const res = await TEST_POST(testRequest({ type: 'webhook', url }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: `Refusing to follow a redirect response from ${url}.` });
  });

  it('sends the email test to the resolved SMTP address', async () => {
    const smtp = await startSmtpServer();
    try {
      setDnsLookupForTests(async () => [{ address: '127.0.0.1' }]);

      const res = await TEST_POST(testRequest({ type: 'email', config: smtpConfig('smtp.example.test', smtp.port) }));

      expect(await res.json()).toEqual({ ok: true });
      expect(smtp.connections()).toBe(1);
    } finally {
      await smtp.stop();
    }
  });

  it('refuses an SMTP host whose answer is private, without connecting', async () => {
    const smtp = await startSmtpServer();
    try {
      setDnsLookupForTests(async () => [{ address: '192.168.4.4' }]);

      const res = await TEST_POST(testRequest({ type: 'email', config: smtpConfig('smtp.example.test', smtp.port) }));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        ok: false,
        error: 'SMTP host is not allowed: smtp.example.test resolves to 192.168.4.4, which is not a public address.',
      });
      expect(smtp.connections()).toBe(0);
    } finally {
      await smtp.stop();
    }
  });
});
