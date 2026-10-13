/** The old Users address, kept alive for anyone who bookmarked or guessed it. */
import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';

describe('next.config redirects', () => {
  it('sends /settings/users to /access, temporarily', async () => {
    const redirects = await nextConfig.redirects!();
    expect(redirects).toContainEqual({ source: '/settings/users', destination: '/access', permanent: false });
  });

  it('does not redirect /settings itself', async () => {
    const redirects = await nextConfig.redirects!();
    expect(redirects.find(r => r.source === '/settings')).toBeUndefined();
  });
});
