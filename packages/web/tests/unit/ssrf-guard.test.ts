import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isBlockedAddress,
  assertPublicHost,
  assertSafeWebhookUrl,
  guardedFetch,
  resolveSmtpAddresses,
  SsrfGuardError,
  allowAddressesForTests,
  setDnsLookupForTests,
  setGuardedTransportForTests,
  trustCertificateForTests,
  resetDnsLookupForTests,
} from '@/lib/ssrf-guard';
import { createSelfSignedCert } from '../helpers/self-signed-cert';

afterEach(async () => {
  resetDnsLookupForTests();
});

describe('isBlockedAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['10.0.0.5', 'private 10/8'],
    ['172.16.0.1', 'private 172.16/12'],
    ['192.168.1.1', 'private 192.168/16'],
    ['169.254.169.254', 'link-local / cloud metadata'],
    ['100.64.0.1', 'CGNAT'],
    ['198.18.0.1', 'benchmark'],
    ['240.0.0.1', 'reserved'],
    ['0.0.0.5', '"this network"'],
    ['224.0.0.1', 'multicast'],
    ['::1', 'IPv6 loopback'],
    ['::', 'IPv6 unspecified'],
    ['fc00::1', 'IPv6 unique-local'],
    ['fe80::1', 'IPv6 link-local'],
    ['ff02::1', 'IPv6 multicast'],
    ['::ffff:127.0.0.1', 'IPv4-mapped IPv6 loopback'],
    ['::ffff:169.254.169.254', 'IPv4-mapped IPv6 metadata'],
  ])('blocks %s (%s)', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  // IPv6 forms that carry an IPv4 address: the embedded address is what gets connected to.
  it.each([
    ['64:ff9b::7f00:1', 'NAT64 embedding 127.0.0.1'],
    ['64:ff9b::a9fe:a9fe', 'NAT64 embedding 169.254.169.254'],
    ['64:ff9b::a00:5', 'NAT64 embedding 10.0.0.5'],
    ['64:ff9b::127.0.0.1', 'NAT64 with a dotted-quad tail'],
    ['64:ff9b:1::1', 'NAT64 local-use prefix'],
    ['64:ff9b:1:abcd::7f00:1', 'NAT64 local-use prefix, longer'],
    ['2002:7f00:1::', '6to4 embedding 127.0.0.1'],
    ['2002:a9fe:a9fe::1', '6to4 embedding 169.254.169.254'],
    ['2002:c0a8:101::', '6to4 embedding 192.168.1.1'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'Teredo'],
    ['2001::1', 'Teredo, compressed'],
  ])('blocks %s (%s)', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  // ::/96 IPv4-compatible (deprecated): some stacks still route it to the embedded IPv4 address,
  // so the form is blocked whatever the tail is. 100::/64 is the discard-only prefix (RFC 6666).
  it.each([
    ['::127.0.0.1', 'IPv4-compatible embedding loopback'],
    ['::7f00:1', 'IPv4-compatible embedding loopback, hex'],
    ['::10.0.0.1', 'IPv4-compatible embedding 10.0.0.1'],
    ['::8.8.8.8', 'IPv4-compatible embedding a public address'],
    ['::808:808', 'IPv4-compatible embedding a public address, hex'],
    ['100::1', 'discard-only prefix'],
    ['100::ffff:ffff:ffff:ffff', 'discard-only prefix, last address'],
  ])('blocks %s (%s)', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    ['100:0:0:1::1', 'outside the 100::/64 discard-only prefix'],
  ])('does not block %s (%s)', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it.each([
    ['8.8.8.8'],
    ['1.1.1.1'],
    ['2606:4700:4700::1111'],
    ['64:ff9b::808:808'],
    ['64:ff9b::8.8.8.8'],
    ['2002:808:808::1'],
    ['2001:4860:4860::8888'],
  ])('allows public address %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('assertPublicHost', () => {
  it('rejects a literal private IP without calling the resolver', async () => {
    const lookup = vi.fn();
    setDnsLookupForTests(lookup);
    await expect(assertPublicHost('169.254.169.254')).rejects.toThrow(SsrfGuardError);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('accepts a literal public IP without calling the resolver', async () => {
    const lookup = vi.fn();
    setDnsLookupForTests(lookup);
    await expect(assertPublicHost('8.8.8.8')).resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects a hostname that resolves to a private address', async () => {
    setDnsLookupForTests(async () => [{ address: '10.0.0.1' }]);
    await expect(assertPublicHost('internal.example.test')).rejects.toThrow(SsrfGuardError);
  });

  it('accepts a hostname that resolves to a public address', async () => {
    setDnsLookupForTests(async () => [{ address: '93.184.216.34' }]);
    await expect(assertPublicHost('public.example.test')).resolves.toBeUndefined();
  });

  it('rejects if any resolved address (of several) is private', async () => {
    setDnsLookupForTests(async () => [{ address: '93.184.216.34' }, { address: '127.0.0.1' }]);
    await expect(assertPublicHost('mixed.example.test')).rejects.toThrow(SsrfGuardError);
  });

  it('rejects when resolution never settles (timeout)', async () => {
    setDnsLookupForTests(() => new Promise(() => { /* never resolves */ }));
    await expect(assertPublicHost('slow.example.test')).rejects.toThrow(SsrfGuardError);
  }, 10_000);
});

describe('resolveSmtpAddresses', () => {
  const cfg = { host: 'smtp.example.test' };

  it('lists IPv4 first, then IPv6, keeping the resolver order within a family', async () => {
    setDnsLookupForTests(async () => [
      { address: '2606:4700:4700::1111' },
      { address: '93.184.216.34' },
      { address: '2001:4860:4860::8888' },
      { address: '8.8.4.4' },
    ]);
    // Four answers, so the cap also applies; the first three in the wanted order are kept.
    await expect(resolveSmtpAddresses(cfg)).resolves.toEqual([
      '93.184.216.34',
      '8.8.4.4',
      '2606:4700:4700::1111',
    ]);
  });

  it('stops at three addresses', async () => {
    setDnsLookupForTests(async () => [
      { address: '93.184.216.34' }, { address: '8.8.8.8' }, { address: '1.1.1.1' }, { address: '8.8.4.4' },
    ]);
    await expect(resolveSmtpAddresses(cfg)).resolves.toEqual(['93.184.216.34', '8.8.8.8', '1.1.1.1']);
  });

  it('lists a repeated address once', async () => {
    setDnsLookupForTests(async () => [{ address: '93.184.216.34' }, { address: '93.184.216.34' }, { address: '8.8.8.8' }]);
    await expect(resolveSmtpAddresses(cfg)).resolves.toEqual(['93.184.216.34', '8.8.8.8']);
  });

  it('still refuses the whole host when any one address, even a later one, is not public', async () => {
    setDnsLookupForTests(async () => [
      { address: '93.184.216.34' }, { address: '8.8.8.8' }, { address: '1.1.1.1' }, { address: '10.0.0.5' },
    ]);
    await expect(resolveSmtpAddresses(cfg))
      .rejects.toThrow('SMTP host is not allowed: smtp.example.test resolves to 10.0.0.5, which is not a public address.');
  });
});

describe('assertSafeWebhookUrl', () => {
  it('rejects a non-http(s) scheme before resolving', async () => {
    const lookup = vi.fn();
    setDnsLookupForTests(lookup);
    await expect(assertSafeWebhookUrl('ftp://example.com/x')).rejects.toThrow(SsrfGuardError);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects javascript: URLs', async () => {
    await expect(assertSafeWebhookUrl('javascript:alert(1)')).rejects.toThrow(SsrfGuardError);
  });

  it('accepts an https URL resolving to a public address', async () => {
    setDnsLookupForTests(async () => [{ address: '93.184.216.34' }]);
    await expect(assertSafeWebhookUrl('https://public.example.test/hook')).resolves.toBeUndefined();
  });
});

describe('guardedFetch', () => {
  it('throws instead of following a redirect response', async () => {
    setDnsLookupForTests(async () => [{ address: '93.184.216.34' }]);
    setGuardedTransportForTests(vi.fn().mockResolvedValue({ status: 302, type: 'basic' } as Response));
    await expect(guardedFetch('https://public.example.test/hook', { method: 'POST' }))
      .rejects.toThrow(SsrfGuardError);
  });

  it('returns the response when it is not a redirect', async () => {
    setDnsLookupForTests(async () => [{ address: '93.184.216.34' }]);
    const ok = { status: 200, type: 'basic', ok: true } as Response;
    setGuardedTransportForTests(vi.fn().mockResolvedValue(ok));
    await expect(guardedFetch('https://public.example.test/hook', { method: 'POST' })).resolves.toBe(ok);
  });

  it('never calls fetch when the destination is blocked', async () => {
    const fetchMock = vi.fn();
    setGuardedTransportForTests(fetchMock);
    await expect(guardedFetch('http://169.254.169.254/latest', { method: 'POST' }))
      .rejects.toThrow(SsrfGuardError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hands the transport only the addresses that passed the check', async () => {
    setDnsLookupForTests(async () => [{ address: '93.184.216.34' }, { address: '2606:4700:4700::1111' }]);
    const transport = vi.fn().mockResolvedValue({ status: 200, type: 'basic', ok: true } as Response);
    setGuardedTransportForTests(transport);
    await guardedFetch('https://public.example.test/hook', { method: 'POST' });
    expect(transport.mock.calls[0][2]).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
  });
});

describe('guardedFetch over a real socket', () => {
  let server: http.Server;
  let port: number;
  let requests: { host: string | undefined; body: string }[];
  let respond: (res: http.ServerResponse) => void;

  beforeEach(async () => {
    requests = [];
    respond = res => { res.statusCode = 200; res.end('ok'); };
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        requests.push({ host: req.headers.host, body });
        respond(res);
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('connects to the one address it resolved, with the original hostname as Host', async () => {
    // The hostname does not exist anywhere: only a connection to the checked address can succeed.
    allowAddressesForTests(['127.0.0.1']);
    const lookup = vi.fn().mockResolvedValue([{ address: '127.0.0.1' }]);
    setDnsLookupForTests(lookup);

    const res = await guardedFetch(`http://pinned.example.test:${port}/hook`, { method: 'POST', body: '{"a":1}' });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(requests).toEqual([{ host: `pinned.example.test:${port}`, body: '{"a":1}' }]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('does not resolve again at connect time: a later private answer is never used', async () => {
    allowAddressesForTests(['127.0.0.1']);
    const answers = [[{ address: '127.0.0.1' }], [{ address: '169.254.169.254' }]];
    let call = 0;
    const lookup = vi.fn(async () => answers[Math.min(call++, answers.length - 1)]);
    setDnsLookupForTests(lookup);

    const res = await guardedFetch(`http://rebind.example.test:${port}/hook`, { method: 'POST', body: 'x' });

    expect(res.status).toBe(200);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
  });

  it('checks every connection: a send whose answer turned private is refused and never connects', async () => {
    allowAddressesForTests(['127.0.0.1']);
    const answers = [[{ address: '127.0.0.1' }], [{ address: '169.254.169.254' }]];
    let call = 0;
    setDnsLookupForTests(async () => answers[Math.min(call++, answers.length - 1)]);

    await guardedFetch(`http://rebind.example.test:${port}/hook`, { method: 'POST', body: 'x' });
    await expect(guardedFetch(`http://rebind.example.test:${port}/hook`, { method: 'POST', body: 'x' }))
      .rejects.toThrow('rebind.example.test resolves to 169.254.169.254, which is not a public address.');

    expect(requests).toHaveLength(1);
  });

  it('does not connect to a loopback server when nothing has allowed it', async () => {
    setDnsLookupForTests(async () => [{ address: '127.0.0.1' }]);
    await expect(guardedFetch(`http://loop.example.test:${port}/hook`, { method: 'POST', body: 'x' }))
      .rejects.toThrow(SsrfGuardError);
    expect(requests).toHaveLength(0);
  });

  it('refuses a redirect response and does not follow it', async () => {
    allowAddressesForTests(['127.0.0.1']);
    setDnsLookupForTests(async () => [{ address: '127.0.0.1' }]);
    respond = res => { res.statusCode = 302; res.setHeader('Location', '/elsewhere'); res.end(); };

    const url = `http://redirect.example.test:${port}/hook`;
    await expect(guardedFetch(url, { method: 'POST', body: 'x' }))
      .rejects.toThrow(`Refusing to follow a redirect response from ${url}.`);
    expect(requests).toHaveLength(1);
  });

  it('returns a non-2xx response with its status and body', async () => {
    allowAddressesForTests(['127.0.0.1']);
    setDnsLookupForTests(async () => [{ address: '127.0.0.1' }]);
    respond = res => { res.statusCode = 500; res.end('boom'); };

    const res = await guardedFetch(`http://fail.example.test:${port}/hook`, { method: 'POST', body: 'x' });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('boom');
  });

  it('rejects with the signal\'s timeout when the server never answers', async () => {
    allowAddressesForTests(['127.0.0.1']);
    setDnsLookupForTests(async () => [{ address: '127.0.0.1' }]);
    respond = () => { /* never answers */ };

    const sent = guardedFetch(`http://slow.example.test:${port}/hook`, {
      method: 'POST',
      body: 'x',
      signal: AbortSignal.timeout(150),
    });
    await expect(sent).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

describe('guardedFetch over a pinned HTTPS connection', () => {
  let server: https.Server;
  let port: number;
  let pem: { key: string; cert: string };
  let requests: (string | undefined)[];

  beforeEach(async () => {
    pem = createSelfSignedCert('pinned.example.test');
    requests = [];
    server = https.createServer({ key: pem.key, cert: pem.cert }, (req, res) => {
      requests.push(req.headers.host);
      res.statusCode = 200;
      res.end('ok');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    allowAddressesForTests(['127.0.0.1']);
    // Both names resolve to the one server: only the certificate can tell them apart.
    setDnsLookupForTests(async () => [{ address: '127.0.0.1' }]);
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('connects when the URL\'s hostname is the one the certificate was issued for', async () => {
    trustCertificateForTests(pem.cert);

    const res = await guardedFetch(`https://pinned.example.test:${port}/hook`, { method: 'POST', body: 'x' });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(requests).toEqual([`pinned.example.test:${port}`]);
  });

  it('rejects a different hostname that resolves to the same address, on the certificate name', async () => {
    trustCertificateForTests(pem.cert);

    await expect(guardedFetch(`https://other.example.test:${port}/hook`, { method: 'POST', body: 'x' }))
      .rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    expect(requests).toHaveLength(0);
  });

  it('rejects the certificate\'s own hostname when that certificate is not trusted', async () => {
    await expect(guardedFetch(`https://pinned.example.test:${port}/hook`, { method: 'POST', body: 'x' }))
      .rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    expect(requests).toHaveLength(0);
  });
});