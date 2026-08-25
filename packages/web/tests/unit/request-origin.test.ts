/**
 * `correctedRequestUrl` (lib/request-origin.ts) repairs the origin the standalone server stamps
 * onto every request from its own bind address. The contract is deliberately narrow: only the
 * unspecified addresses (0.0.0.0, [::]) are ever rewritten, because they are the only hosts that
 * prove the URL cannot be what the browser used. Everything else, localhost and private IPs
 * included, is someone's configuration and must pass through untouched. See #49.
 */
import { describe, expect, it } from 'vitest';
import { correctedRequestUrl } from '../../lib/request-origin';

const h = (entries: Record<string, string>) => new Headers(entries);

describe('correctedRequestUrl', () => {
  it('rewrites a 0.0.0.0 origin from x-forwarded-host, keeping path and query', () => {
    expect(
      correctedRequestUrl('http://0.0.0.0:3000/api/auth/signin?callbackUrl=%2Fscans', h({
        'x-forwarded-host': 'localhost:3000',
      })),
    ).toBe('http://localhost:3000/api/auth/signin?callbackUrl=%2Fscans');
  });

  it('rewrites the IPv6 unspecified address the same way', () => {
    expect(
      correctedRequestUrl('http://[::]:3000/signin', h({ 'x-forwarded-host': 'localhost:3000' })),
    ).toBe('http://localhost:3000/signin');
  });

  it('honours x-forwarded-proto https and a portless public host', () => {
    expect(
      correctedRequestUrl('http://0.0.0.0:3000/api/auth/callback/microsoft-entra-id', h({
        'x-forwarded-host': 'rulebeat.example.com',
        'x-forwarded-proto': 'https',
      })),
    ).toBe('https://rulebeat.example.com/api/auth/callback/microsoft-entra-id');
  });

  it('takes the first hop of a comma-separated forwarded chain', () => {
    expect(
      correctedRequestUrl('http://0.0.0.0:3000/x', h({
        'x-forwarded-host': 'public.example.com, internal-lb:8080',
      })),
    ).toBe('http://public.example.com/x');
  });

  it('falls back to the host header when nothing forwarded', () => {
    expect(
      correctedRequestUrl('http://0.0.0.0:3000/x', h({ host: 'localhost:3000' })),
    ).toBe('http://localhost:3000/x');
  });

  it('leaves localhost alone: it is a browsable origin, not a bind address', () => {
    expect(
      correctedRequestUrl('http://localhost:3000/x', h({ 'x-forwarded-host': 'other.example' })),
    ).toBeNull();
  });

  it('leaves a private IP alone for the same reason', () => {
    expect(
      correctedRequestUrl('http://10.0.0.4:3000/x', h({ 'x-forwarded-host': 'other.example' })),
    ).toBeNull();
  });

  it('refuses a forwarded host that is itself unspecified', () => {
    expect(
      correctedRequestUrl('http://0.0.0.0:3000/x', h({ 'x-forwarded-host': '0.0.0.0:3000' })),
    ).toBeNull();
  });

  it('returns null when no header knows the real host', () => {
    expect(correctedRequestUrl('http://0.0.0.0:3000/x', h({}))).toBeNull();
  });

  it('returns null for junk it cannot parse', () => {
    expect(correctedRequestUrl('not a url', h({ 'x-forwarded-host': 'localhost' }))).toBeNull();
    expect(correctedRequestUrl('http://0.0.0.0:3000/x', h({ 'x-forwarded-host': 'not a host' }))).toBeNull();
  });
});
