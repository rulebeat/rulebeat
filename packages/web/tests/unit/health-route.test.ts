/**
 * GET /api/health is a container liveness probe: unauthenticated, no DB, no
 * Azure call. This asserts the actual response shape rather than just that the route exists.
 */
import { describe, expect, it } from 'vitest';
import { GET } from '@/app/api/health/route';

describe('GET /api/health', () => {
  it('returns 200 with a stable ok body and no-store caching', async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'ok' });
  });
});
