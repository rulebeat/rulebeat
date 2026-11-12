/**
 * The words the share flow says (#357): the confirmation spells out what becomes visible, per kind of item, and
 * the client request turns each answer into a message the person can act on.
 */
import { describe, expect, it, vi } from 'vitest';
import { NOT_ELIGIBLE_TO_OWN, shareConfirmation, staleStateMessage } from '@/lib/item-sharing';
import { requestVisibilityChange } from '@/lib/item-sharing-client';
import { fetchHandOverCandidates, requestTakeOver, requestHandOver } from '@/lib/item-transfer-client';

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

  it('shows the server\'s message for the 400 that names the widgets using a view that is no longer shared', async () => {
    const message = '2 widgets use saved views that are no longer shared: Open, Fixed. Change or remove them before saving.';
    expect(await requestVisibilityChange('dashboard', 'x', 'share', reply(400, { error: message }))).toEqual({ ok: false, error: message });
  });

  it('gives the fixed message for a 400 with no usable message', async () => {
    const fallback = { ok: false, error: 'The change could not be saved. Try again.' };
    expect(await requestVisibilityChange('dashboard', 'x', 'share', reply(400, { error: '  ' }))).toEqual(fallback);
    expect(await requestVisibilityChange('dashboard', 'x', 'share', reply(400))).toEqual(fallback);
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

describe('the hand over and take over requests', () => {
  const reply = (status: number, payload?: unknown, redirected = false) =>
    vi.fn(async () => {
      const res = new Response(payload === undefined ? null : JSON.stringify(payload), { status });
      Object.defineProperty(res, 'redirected', { value: redirected });
      return res;
    });
  const FALLBACK = { ok: false, error: 'The change could not be saved. Try again.' };

  it('asks the candidate route of the kind and hands back the people, or null when the list is unavailable', async () => {
    const people = [{ id: 'u1', displayName: 'Ada', email: 'ada@example.com' }];
    const fetchImpl = reply(200, people);
    expect(await fetchHandOverCandidates('view', 'a b', fetchImpl)).toEqual({ ok: true, people });
    expect(fetchImpl).toHaveBeenCalledWith('/api/views/a%20b/hand-over-candidates');
    expect(await fetchHandOverCandidates('dashboard', 'x', reply(409, { error: staleStateMessage('dashboard') })))
      .toEqual({ ok: false, error: staleStateMessage('dashboard') });
    expect(await fetchHandOverCandidates('dashboard', 'x', reply(500, { error: 'tenant 0000' })))
      .toEqual({ ok: false, error: 'The list of people could not be loaded. Try again.' });
    expect(await fetchHandOverCandidates('dashboard', 'x', vi.fn(async () => { throw new Error('offline'); })))
      .toEqual({ ok: false, error: 'The list of people could not be loaded. Try again.' });
  });

  it('posts the chosen person as JSON to the hand-over route and hands back the item', async () => {
    const fetchImpl = reply(200, { id: 'abc', visibility: 'shared' });
    expect(await requestHandOver('dashboard', 'a b', 'u1', fetchImpl)).toEqual({ ok: true, item: { id: 'abc', visibility: 'shared' } });
    expect(fetchImpl).toHaveBeenCalledWith('/api/dashboards/a%20b/hand-over', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'u1' }),
    });
  });

  it('posts to the take-over route with no body', async () => {
    const fetchImpl = reply(200, { id: 'abc' });
    expect(await requestTakeOver('view', 'x', fetchImpl)).toEqual({ ok: true, item: { id: 'abc' } });
    expect(fetchImpl).toHaveBeenCalledWith('/api/views/x/take-over', { method: 'POST' });
  });

  it('shows the server\'s message for a 400 or 409, and a fixed one for anything else', async () => {
    expect(await requestHandOver('view', 'x', 'u1', reply(400, { error: NOT_ELIGIBLE_TO_OWN }))).toEqual({ ok: false, error: NOT_ELIGIBLE_TO_OWN });
    expect(await requestTakeOver('view', 'x', reply(409, { error: staleStateMessage('view') }))).toEqual({ ok: false, error: staleStateMessage('view') });
    expect(await requestTakeOver('view', 'x', reply(404, { error: 'Not found' }))).toEqual({ ok: false, error: 'This saved view no longer exists.' });
    expect(await requestHandOver('view', 'x', 'u1', reply(403, { error: 'Forbidden' }))).toEqual({ ok: false, error: 'Your access does not let you hand this over.' });
    expect(await requestTakeOver('view', 'x', reply(403, { error: 'Forbidden' }))).toEqual({ ok: false, error: 'Your access does not let you take this over.' });
    expect(await requestHandOver('view', 'x', 'u1', reply(500, { error: 'tenant 0000 failed' }))).toEqual(FALLBACK);
    expect(await requestTakeOver('view', 'x', reply(200, {}, true))).toEqual(FALLBACK);
    expect(await requestTakeOver('view', 'x', vi.fn(async () => { throw new Error('offline'); }))).toEqual(FALLBACK);
  });
});
