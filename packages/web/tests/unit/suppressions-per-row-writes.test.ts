/**
 * Issue #142, suppressions side: adding or removing one suppression writes only that row, so a
 * suppression created or removed at the same moment is not put back by the other request's save.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addSuppression, removeSuppression, loadSuppressions } from '@/lib/suppressions';
import { resetDb } from '../helpers/db';
import type { Suppression } from '@/lib/types';

function suppression(id: string, overrides: Partial<Suppression> = {}): Suppression {
  return {
    id,
    fingerprint: 'fp-' + id,
    resourceId: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/' + id,
    reason: 'accepted risk',
    suppressedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('per-row suppression writes', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('keeps both suppressions when two are added at the same time', async () => {
    await Promise.all([addSuppression(suppression('one')), addSuppression(suppression('two'))]);

    expect((await loadSuppressions()).map(s => s.id).sort()).toEqual(['one', 'two']);
  });

  it('removing one suppression leaves the others, including one added after the caller last read', async () => {
    await addSuppression(suppression('keep'));
    await addSuppression(suppression('drop'));
    await loadSuppressions(); // the caller's read, now about to go stale
    await addSuppression(suppression('late'));

    const removed = await removeSuppression('drop');

    expect(removed).toEqual(suppression('drop'));
    expect((await loadSuppressions()).map(s => s.id).sort()).toEqual(['keep', 'late']);
  });

  it('returns null for an unknown id and removes nothing', async () => {
    await addSuppression(suppression('only'));

    expect(await removeSuppression('missing')).toBeNull();
    expect((await loadSuppressions()).map(s => s.id)).toEqual(['only']);
  });

  it('round-trips expiry and a missing resource id', async () => {
    await addSuppression(suppression('x', { expiresAt: '2030-01-01T00:00:00.000Z', resourceId: undefined }));

    expect((await loadSuppressions())[0]).toEqual({
      id: 'x',
      fingerprint: 'fp-x',
      reason: 'accepted risk',
      suppressedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
  });
});
