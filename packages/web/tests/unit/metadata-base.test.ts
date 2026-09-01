/**
 * `metadataBase` is what turns `/opengraph-image.png` into a URL a link-preview crawler can
 * actually fetch. Getting it wrong is silent: the page renders, the tags are present, and only the
 * preview is broken, on someone else's machine. So pin the precedence rather than trusting it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestHeaders = new Map<string, string>();

vi.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => requestHeaders.get(name.toLowerCase()) ?? null }),
}));

const { resolveMetadataBase } = await import('@/lib/metadata-base');

/** tests/setup.ts sets AUTH_URL for the rest of the suite; each case here states its own. */
function setEnv(value: string | undefined) {
  if (value === undefined) delete process.env.AUTH_URL;
  else process.env.AUTH_URL = value;
}

beforeEach(async () => {
  requestHeaders.clear();
  setEnv(undefined);
});

describe('resolveMetadataBase', () => {
  it('uses AUTH_URL when it is set, ignoring the request', async () => {
    setEnv('https://rulebeat.example.com');
    requestHeaders.set('host', 'internal:3000');
    expect((await resolveMetadataBase())?.origin).toBe('https://rulebeat.example.com');
  });

  it('ignores an AUTH_URL that is only whitespace', async () => {
    setEnv('   ');
    requestHeaders.set('host', 'rulebeat.example.com');
    expect((await resolveMetadataBase())?.origin).toBe('http://rulebeat.example.com');
  });

  // A misconfigured value must not take the page down with it: a broken preview is recoverable,
  // a 500 on every route is not.
  it('falls back to the request when AUTH_URL is not a URL', async () => {
    setEnv('not a url');
    requestHeaders.set('host', 'rulebeat.example.com');
    requestHeaders.set('x-forwarded-proto', 'https');
    expect((await resolveMetadataBase())?.origin).toBe('https://rulebeat.example.com');
  });

  it('prefers the forwarded host over the internal one', async () => {
    requestHeaders.set('host', 'localhost:3000');
    requestHeaders.set('x-forwarded-host', 'rulebeat.example.com');
    requestHeaders.set('x-forwarded-proto', 'https');
    expect((await resolveMetadataBase())?.origin).toBe('https://rulebeat.example.com');
  });

  it('assumes http when no forwarded protocol is sent', async () => {
    requestHeaders.set('host', 'rulebeat.example.com');
    expect((await resolveMetadataBase())?.origin).toBe('http://rulebeat.example.com');
  });

  it('returns undefined rather than a guess when there is no host at all', async () => {
    expect(await resolveMetadataBase()).toBeUndefined();
  });

  it('returns undefined rather than throwing on a junk host header', async () => {
    requestHeaders.set('host', 'a b c');
    expect(await resolveMetadataBase()).toBeUndefined();
  });
});
