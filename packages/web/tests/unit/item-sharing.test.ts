/**
 * The words the share flow says (#357): the confirmation spells out what becomes visible, per kind of item, and
 * the client request turns each answer into a message the person can act on.
 */
import { describe, expect, it, vi } from 'vitest';
import { shareConfirmation, staleStateMessage } from '@/lib/item-sharing';
import { requestVisibilityChange } from '@/lib/item-sharing-client';

describe('shareConfirmation', () => {
  it('names what a dashboard shows everyone', () => {
    expect(shareConfirmation('dashboard', 'Team numbers')).toBe(
      'Share Team numbers with everyone on this install? Its name, description, widget titles and search text will be visible to everyone, and its name will appear in the audit log.');
  });

  it('names what a saved view shows everyone', () => {
    expect(shareConfirmation('view', 'Critical only')).toBe(
      'Share Critical only with everyone on this install? Its name and search text will be visible to everyone, and its name will appear in the audit log.');
  });
});

describe('requestVisibilityChange', () => {
  const reply = (status: number, payload?: unknown, redirected = false) =>
    vi.fn(async () => {
      const res = new Response(payload === undefined ? null : JSON.stringify(payload), { status });
      Object.defineProperty(res, 'redirected', { value: redirected });
      return res;
    });

  it('posts to the share or unshare route of the kind and hands back the item', async () => {
    const fetchImpl = reply(200, { id: 'abc', visibility: 'shared' });
    expect(await requestVisibilityChange('view', 'a b', 'share', fetchImpl)).toEqual({ ok: true, item: { id: 'abc', visibility: 'shared' } });
    expect(fetchImpl).toHaveBeenCalledWith('/api/views/a%20b/share', { method: 'POST' });
    await requestVisibilityChange('dashboard', 'x', 'unshare', fetchImpl);
    expect(fetchImpl).toHaveBeenLastCalledWith('/api/dashboards/x/unshare', { method: 'POST' });
  });

  it('shows the server\'s message for a refusal the person can act on', async () => {
    expect(await requestVisibilityChange('dashboard', 'x', 'share', reply(409, { error: staleStateMessage('dashboard') })))
      .toEqual({ ok: false, error: staleStateMessage('dashboard') });
  });

  it('says the item is gone for a 404, and a fixed message for a 403, a failure, a redirect and a thrown fetch', async () => {
    expect(await requestVisibilityChange('view', 'x', 'share', reply(404, { error: 'Not found' }))).toEqual({ ok: false, error: 'This saved view no longer exists.' });
    expect(await requestVisibilityChange('view', 'x', 'share', reply(403, { error: 'Forbidden' }))).toEqual({ ok: false, error: 'Your access does not let you share this.' });
    expect(await requestVisibilityChange('view', 'x', 'unshare', reply(403, { error: 'Forbidden' }))).toEqual({ ok: false, error: 'Your access does not let you unshare this.' });
    const fallback = { ok: false, error: 'The change could not be saved. Try again.' };
    expect(await requestVisibilityChange('view', 'x', 'share', reply(500, { error: 'tenant 0000 failed' }))).toEqual(fallback);
    expect(await requestVisibilityChange('view', 'x', 'share', reply(200, {}, true))).toEqual(fallback);
    expect(await requestVisibilityChange('view', 'x', 'share', vi.fn(async () => { throw new Error('offline'); }))).toEqual(fallback);
  });
});
