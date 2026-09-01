import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isBlockedAddress,
  assertPublicHost,
  assertSafeWebhookUrl,
  guardedFetch,
  SsrfGuardError,
  setDnsLookupForTests,
  resetDnsLookupForTests,
} from '@/lib/ssrf-guard';

afterEach(async () => {
  resetDnsLookupForTests();
  vi.unstubAllGlobals();
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

  it.each([
    ['8.8.8.8'],
    ['1.1.1.1'],
    ['2606:4700:4700::1111'],
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 302, type: 'basic' } as Response));
    await expect(guardedFetch('https://public.example.test/hook', { method: 'POST' }))
      .rejects.toThrow(SsrfGuardError);
  });

  it('returns the response when it is not a redirect', async () => {
    setDnsLookupForTests(async () => [{ address: '93.184.216.34' }]);
    const ok = { status: 200, type: 'basic', ok: true } as Response;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok));
    await expect(guardedFetch('https://public.example.test/hook', { method: 'POST' })).resolves.toBe(ok);
  });

  it('never calls fetch when the destination is blocked', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(guardedFetch('http://169.254.169.254/latest', { method: 'POST' }))
      .rejects.toThrow(SsrfGuardError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
