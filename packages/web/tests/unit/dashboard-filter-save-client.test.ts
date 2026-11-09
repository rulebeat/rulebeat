/**
 * What the page sends to save the dashboard's filters and how it reads the answer. The fetch is a fake:
 * the contract is the body that goes out and the outcome a person is shown for each status.
 */
import { describe, expect, it, vi } from 'vitest';
import { sendFiltersSave } from '@/lib/dashboard-filter-save-client';

const reply = (status: number, body: unknown) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

describe('sending the save', () => {
  it('puts the revision and the changes to the filters route', async () => {
    const fetchImpl = reply(200, { revision: 5, bar: { revision: 5 }, dashboard: { id: 'd1', revision: 5 } });
    await sendFiltersSave('d1', 4, { severity: ['high'] }, fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('/api/dashboards/d1/filters');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ revision: 4, changes: { severity: ['high'] } });
  });

  it('adopts the new revision, the bar and the dashboard the server returned', async () => {
    const outcome = await sendFiltersSave('d1', 4, {}, reply(200, { revision: 5, bar: { revision: 5 }, dashboard: { id: 'd1', revision: 5 } }));
    expect(outcome).toEqual({ kind: 'saved', revision: 5, bar: { revision: 5 }, dashboard: { id: 'd1', revision: 5 } });
  });

  it('reads a refusal for values outside the person\'s access with how many to remove', async () => {
    const outcome = await sendFiltersSave('d1', 4, {}, reply(422, { error: 'Remove them.', code: 'outside-access', count: 2 }));
    expect(outcome).toEqual({ kind: 'refused', message: 'Remove them.', outside: 2 });
  });

  it('reads the refusal of any as a refusal with nothing to remove', async () => {
    const outcome = await sendFiltersSave('d1', 4, {}, reply(422, { error: 'Pick values.', code: 'any-over-held-back', dimensions: ['subscription'] }));
    expect(outcome).toEqual({ kind: 'refused', message: 'Pick values.' });
  });

  it('reads a stale revision as a conflict that carries the current one', async () => {
    const outcome = await sendFiltersSave('d1', 4, {}, reply(409, { error: 'Changed.', revision: 9 }));
    expect(outcome).toEqual({ kind: 'conflict', revision: 9, message: 'Changed.' });
  });

  it('carries who changed the saved filters, when, and the bar the newer revision brought', async () => {
    const bar = { revision: 9 };
    const outcome = await sendFiltersSave('d1', 4, {}, reply(409, { error: 'Changed.', revision: 9, bar, changedBy: 'Sam', changedAt: '2026-11-09T10:30:00.000Z' }));
    expect(outcome).toEqual({ kind: 'conflict', revision: 9, message: 'Changed.', bar, changedBy: 'Sam', changedAt: '2026-11-09T10:30:00.000Z' });
  });

  it('reads an unknown dashboard as no longer available to the person', async () => {
    const outcome = await sendFiltersSave('d1', 4, {}, reply(404, { error: 'Not found' }));
    expect(outcome).toEqual({ kind: 'gone', message: 'This dashboard is no longer available to you' });
  });

  it('reads a lost edit right as forbidden, with the reason the server gave', async () => {
    const outcome = await sendFiltersSave('d1', 4, {}, reply(403, { error: 'You are a Viewer.', reason: 'You are a Viewer.' }));
    expect(outcome).toEqual({ kind: 'forbidden', message: 'You are a Viewer.' });
  });

  it('says it could not save for any other status, and when the request fails', async () => {
    expect(await sendFiltersSave('d1', 4, {}, reply(500, { error: 'Broke' }))).toEqual({ kind: 'failed', message: 'Broke' });
    expect(await sendFiltersSave('d1', 4, {}, vi.fn().mockRejectedValue(new Error('offline')))).toEqual({
      kind: 'failed', message: "The filters could not be saved. Your changes are still in the address.",
    });
  });
});
