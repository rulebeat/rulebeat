/**
 * POST /api/scans/run, issue #146: the route checked only that `targetType` was present, not that
 * it was one of the values `ScheduleTargetType` actually allows, and fired `runManualTarget()`
 * with no `.catch`. An unknown `targetType` reached `runManualTarget()` and threw after the route
 * had already returned 202: an unhandled rejection, and no schedule_runs row for Run History to
 * show it in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const runManualTarget = vi.fn();
vi.mock('@/lib/scheduler', () => ({ runManualTarget: (...args: unknown[]) => runManualTarget(...args) }));

const { POST } = await import('@/app/api/scans/run/route');

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/scans/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function signInAsEditor(): Promise<void> {
  const result = await createUser({ email: 'editor@example.com', role: 'editor' });
  if ('error' in result) throw new Error(result.error);
  await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
}

describe('POST /api/scans/run targetType validation', () => {
  beforeEach(async () => {
    await resetDb();
    mockAuth.mockReset();
    runManualTarget.mockReset();
    await signInAsEditor();
  });

  it('answers 400 for an unknown targetType and never starts a run', async () => {
    const res = await POST(postRequest({ targetType: 'bogus', targetValues: ['x'] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/targetType/i);
    expect(runManualTarget).not.toHaveBeenCalled();
  });

  it('still accepts every real ScheduleTargetType value', async () => {
    runManualTarget.mockResolvedValue({ id: 'run-1' });
    for (const targetType of ['all', 'categories', 'tags', 'rules'] as const) {
      runManualTarget.mockClear();
      const res = await POST(postRequest({ targetType, targetValues: targetType === 'all' ? [] : ['x'] }));
      expect(res.status).toBe(202);
      expect(runManualTarget).toHaveBeenCalledTimes(1);
    }
  });
});

describe('POST /api/scans/run catches a rejected runManualTarget', () => {
  beforeEach(async () => {
    await resetDb();
    mockAuth.mockReset();
    runManualTarget.mockReset();
    await signInAsEditor();
  });

  it('logs the failure server-side instead of leaving it an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    runManualTarget.mockRejectedValue(new Error('boom'));

    const res = await POST(postRequest({ targetType: 'all', targetValues: [] }));
    expect(res.status).toBe(202);

    // Flush the microtask queue so a fire-and-forget rejection has a chance to surface.
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(unhandled).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
    process.off('unhandledRejection', unhandled);
  });
});
