/**
 * GET /api/health is a container liveness probe: unauthenticated, no DB, no
 * Azure call. This asserts the actual response shape rather than just that the route exists.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/health/route';
import { markDemoReady } from '@/lib/demo/readiness';

describe('GET /api/health', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete (globalThis as { __rulebeatDemoReady?: boolean }).__rulebeatDemoReady;
  });

  it('returns 200 with a stable ok body and no-store caching', async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('is not ready in a Demo until the Demo has its data, then is', async () => {
    vi.stubEnv('RULEBEAT_DEMO', '1');

    const starting = await GET();
    expect(starting.status).toBe(503);
    expect(await starting.json()).toEqual({ status: 'starting', reason: 'The Demo is still generating its data.' });

    markDemoReady();
    expect((await GET()).status).toBe(200);
  });
});
