import { describe, expect, it, vi } from 'vitest';
import { requestSavedViewChange, upsertSavedView } from '@/lib/saved-view-actions';
import type { SavedView } from '@/lib/saved-view-query';

const view = (id: string, name: string): SavedView => ({
  id, name, tab: 'results', query: '', createdBy: null, createdAt: '2026-01-01T00:00:00.000Z', updatedBy: null, updatedAt: '2026-01-01T00:00:00.000Z', revision: 1,
});

function fake(status: number, body?: unknown, opts: { redirected?: boolean } = {}) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    redirected: opts.redirected ?? false,
    json: async () => { if (body === undefined) throw new Error('no body'); return body; },
  }) as unknown as Response);
}

describe('requestSavedViewChange', () => {
  it('posts the fields to create and returns the stored view', async () => {
    const fetchImpl = fake(201, view('v1', 'A'));
    const fields = { name: 'A', tab: 'results' as const, query: 'q=x' };
    const outcome = await requestSavedViewChange({ kind: 'create', fields }, fetchImpl);
    expect(outcome).toEqual({ ok: true, view: view('v1', 'A') });
    expect(fetchImpl).toHaveBeenCalledWith('/api/views', expect.objectContaining({ method: 'POST', body: JSON.stringify(fields) }));
  });

  it('patches the revision it holds and only the parts it is given', async () => {
    const fetchImpl = fake(200, view('v1', 'B'));
    await requestSavedViewChange({ kind: 'update', id: 'v1', revision: 4, name: 'B' }, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith('/api/views/v1', expect.objectContaining({ method: 'PATCH', body: '{"revision":4,"name":"B"}' }));
    await requestSavedViewChange({ kind: 'update', id: 'v1', revision: 4, changes: 'severity=low' }, fetchImpl);
    expect(fetchImpl).toHaveBeenLastCalledWith('/api/views/v1', expect.objectContaining({ body: '{"revision":4,"changes":"severity=low"}' }));
  });

  it('posts the open view, its revision and the changes to save from it, and reports how many values were dropped', async () => {
    const fetchImpl = fake(201, { ...view('v2', 'Copy'), dropped: 2 });
    const outcome = await requestSavedViewChange(
      { kind: 'create-from-open', name: 'Copy', tab: 'results', fromView: 'v1', revision: 3, changes: 'q=x' }, fetchImpl,
    );
    expect(outcome).toEqual({ ok: true, view: view('v2', 'Copy'), dropped: 2 });
    expect(fetchImpl).toHaveBeenCalledWith('/api/views', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ name: 'Copy', tab: 'results', fromView: 'v1', revision: 3, changes: 'q=x' }),
    }));
  });

  it('hands back the view as it is now, and who changed it, when the revision was stale', async () => {
    const newer = { ...view('v1', 'A'), revision: 2 };
    const outcome = await requestSavedViewChange(
      { kind: 'update', id: 'v1', revision: 1, changes: '' },
      fake(409, { error: 'This saved view changed since you opened it. Reload to continue.', view: newer, changedBy: 'Sam', changedAt: '2026-11-09T10:30:00.000Z' }),
    );
    expect(outcome).toEqual({
      ok: false, error: 'This saved view changed since you opened it. Reload to continue.',
      conflict: { view: newer, changedBy: 'Sam', changedAt: '2026-11-09T10:30:00.000Z' },
    });
  });

  it('shows a refusal of a value outside the person\'s Access, with how many to remove', async () => {
    const outcome = await requestSavedViewChange(
      { kind: 'update', id: 'v1', revision: 1, changes: 'subscription=x' },
      fake(422, { error: 'Your changes include 2 values outside your access.', code: 'outside-access', count: 2 }),
    );
    expect(outcome).toEqual({ ok: false, error: 'Your changes include 2 values outside your access.', outside: 2 });
  });

  it('says a view opened from is not available when it is gone', async () => {
    const outcome = await requestSavedViewChange(
      { kind: 'create-from-open', name: 'Copy', tab: 'results', fromView: 'v1', revision: 1, changes: '' }, fake(404, { error: 'x' }),
    );
    expect(outcome).toEqual({ ok: false, error: 'This saved view is not available to you' });
  });

  it('deletes with no body and returns no view', async () => {
    const fetchImpl = fake(204);
    const outcome = await requestSavedViewChange({ kind: 'delete', id: 'v1' }, fetchImpl);
    expect(outcome).toEqual({ ok: true, view: null });
    expect(fetchImpl).toHaveBeenCalledWith('/api/views/v1', { method: 'DELETE' });
  });

  it('shows the server message for a name clash or a bad field', async () => {
    for (const status of [400, 409]) {
      const outcome = await requestSavedViewChange(
        { kind: 'create', fields: { name: 'A', tab: 'results', query: '' } },
        fake(status, { error: 'A saved view named "A" already exists.' }),
      );
      expect(outcome).toEqual({ ok: false, error: 'A saved view named "A" already exists.' });
    }
  });

  it('gives a stock message for a missing view or a refused role, never the body', async () => {
    const change = { kind: 'delete' as const, id: 'v1' };
    expect(await requestSavedViewChange(change, fake(404, { error: 'Not found' }))).toEqual({ ok: false, error: 'This saved view no longer exists.' });
    expect(await requestSavedViewChange(change, fake(403, { error: 'secret detail' }))).toEqual({ ok: false, error: 'Your role cannot change saved views.' });
  });

  it('reports a server error, a thrown fetch and a followed redirect as a failure', async () => {
    const change = { kind: 'update' as const, id: 'v1', revision: 1, changes: '' };
    const failed = { ok: false, error: 'The change could not be saved. Try again.' };
    expect(await requestSavedViewChange(change, fake(500, { error: 'boom' }))).toEqual(failed);
    expect(await requestSavedViewChange(change, vi.fn(async () => { throw new Error('offline'); }))).toEqual(failed);
    expect(await requestSavedViewChange(change, fake(200, view('v1', 'A'), { redirected: true }))).toEqual(failed);
  });
});

describe('upsertSavedView', () => {
  it('replaces the view with the same id and keeps the order', () => {
    const next = upsertSavedView([view('a', 'A'), view('b', 'B')], view('a', 'Renamed'));
    expect(next.map(v => v.name)).toEqual(['Renamed', 'B']);
  });

  it('adds a view it has not seen', () => {
    expect(upsertSavedView([view('a', 'A')], view('b', 'B')).map(v => v.id)).toEqual(['a', 'b']);
  });
});
