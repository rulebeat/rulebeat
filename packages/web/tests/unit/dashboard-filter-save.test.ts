/**
 * Filter auto-save (#369, ADR 0012): the debounced save of the filter bar happens only on the owner's own
 * Personal dashboard, carries the revision, and reports a 409 and a 400 in their own words. A Shared dashboard
 * sends nothing, for its owner too: stored filters change only through Save in edit mode.
 */
import { describe, expect, it, vi } from 'vitest';
import { DashboardWrites, SHARED_FILTERS_NOTE, autoSaveFilters, autoSavesFilters, configForSave, filterBarForSave, renameBody, saveDashboardEdits } from '@/lib/dashboard-filter-save';
import { STALE_DASHBOARD_MESSAGE, UNSEEN_VALUE_MESSAGE } from '@/lib/held-back';
import type { HeldBackDashboard } from '@/lib/types';

const ME = { id: 'me' };
const FILTERS = { categories: [], subscriptions: ['sub-a'], resourceGroups: [], tags: [], severities: [], ruleIds: [] };
const WINDOW = { mode: 'relative', days: 30 } as const;

function dashboard(over: Partial<HeldBackDashboard> = {}): HeldBackDashboard {
  return {
    id: 'dash-1', name: 'D', description: '', isDefault: false, createdAt: '', updatedAt: '',
    config: { widgets: [], filters: { subscriptions: [] } },
    owner: { id: 'me', displayName: 'Me', email: 'me@example.com' },
    visibility: 'personal', revision: 7, isInstallDefault: false, isMyDefault: false, heldBack: [],
    ...over,
  } as HeldBackDashboard;
}

const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('who saves filter changes as they are made', () => {
  it('is the owner of a Personal dashboard', () => {
    expect(autoSavesFilters(ME, dashboard())).toBe(true);
  });

  it('is nobody on a Shared dashboard, its owner included', () => {
    expect(autoSavesFilters(ME, dashboard({ visibility: 'shared' }))).toBe(false);
    expect(autoSavesFilters({ id: 'other' }, dashboard({ visibility: 'shared' }))).toBe(false);
    expect(autoSavesFilters(ME, dashboard({ visibility: 'shared', owner: null }))).toBe(false);
  });
});

describe('autoSaveFilters', () => {
  it('sends no request on a Shared dashboard, for its owner', async () => {
    const fetchImpl = answer(200, dashboard());
    const outcome = await autoSaveFilters(ME, dashboard({ visibility: 'shared' }), FILTERS, WINDOW, fetchImpl);
    expect(outcome).toEqual({ kind: 'not-saved' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('puts the filters on a Personal dashboard with the revision and the copy it was sent', async () => {
    const current = dashboard();
    const saved = dashboard({ revision: 8 });
    const fetchImpl = answer(200, saved);
    const outcome = await autoSaveFilters(ME, current, FILTERS, WINDOW, fetchImpl);
    expect(outcome).toEqual({ kind: 'saved', dashboard: saved });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/dashboards/dash-1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      config: { widgets: [], filters: FILTERS, dateWindow: WINDOW },
      revision: 7,
      opened: current.config,
    });
  });

  it('reports a dashboard that changed since it was opened as stale, with the server\'s words', async () => {
    const message = 'This dashboard changed while you were editing it. Reload it and try again.';
    expect(await autoSaveFilters(ME, dashboard(), FILTERS, WINDOW, answer(409, { error: message }))).toEqual({ kind: 'stale', message });
  });

  it('reports a value outside the person\'s Access as refused, with the server\'s words', async () => {
    expect(await autoSaveFilters(ME, dashboard(), FILTERS, WINDOW, answer(400, { error: UNSEEN_VALUE_MESSAGE })))
      .toEqual({ kind: 'refused', message: UNSEEN_VALUE_MESSAGE });
  });

  it('reports any other failure with a fixed message, never the server\'s', async () => {
    expect(await autoSaveFilters(ME, dashboard(), FILTERS, WINDOW, answer(500, { error: 'boom with a tenant id' })))
      .toEqual({ kind: 'failed', message: 'Failed to save the filters.' });
    const thrown = vi.fn(async () => { throw new Error('offline'); });
    expect(await autoSaveFilters(ME, dashboard(), FILTERS, WINDOW, thrown as unknown as typeof fetch))
      .toEqual({ kind: 'failed', message: 'Failed to save the filters.' });
  });
});

describe('the config a save in edit mode sends', () => {
  const changes = { widgets: [], autoRefresh: 60, filters: FILTERS, dateWindow: WINDOW };

  it('carries the filter bar for a Shared dashboard, which stores it only here', () => {
    const config = configForSave(dashboard({ visibility: 'shared' }), changes);
    expect(config.filters).toEqual(FILTERS);
    expect(config.dateWindow).toEqual(WINDOW);
    expect(config.autoRefresh).toBe(60);
  });

  it('keeps the stored filter bar of a Shared dashboard when the save is not a Save in edit mode, such as an auto-refresh change', () => {
    const stored = dashboard({ visibility: 'shared', config: { widgets: [], filters: { subscriptions: ['stored-sub'] }, dateWindow: WINDOW } });
    const config = configForSave(stored, { widgets: [], autoRefresh: 60, filters: undefined, dateWindow: undefined });
    expect(config.filters).toEqual({ subscriptions: ['stored-sub'] });
    expect(config.dateWindow).toEqual(WINDOW);
    expect(config.autoRefresh).toBe(60);
  });

  it('keeps the stored filter bar of a Shared dashboard when "Save changes" is pressed outside edit mode, such as after a widget Configure', () => {
    const stored = dashboard({ visibility: 'shared', config: { widgets: [], filters: { subscriptions: ['stored-sub'] }, dateWindow: WINDOW } });
    const config = configForSave(stored, { widgets: [], autoRefresh: 0, ...filterBarForSave(false, FILTERS, { mode: 'relative', days: 1 }) });
    expect(config.filters).toEqual({ subscriptions: ['stored-sub'] });
    expect(config.dateWindow).toEqual(WINDOW);
  });

  it('stores the filter bar of a Shared dashboard when the save is made in edit mode', () => {
    const stored = dashboard({ visibility: 'shared', config: { widgets: [], filters: { subscriptions: ['stored-sub'] }, dateWindow: WINDOW } });
    const config = configForSave(stored, { widgets: [], autoRefresh: 0, ...filterBarForSave(true, FILTERS, { mode: 'relative', days: 1 }) });
    expect(config.filters).toEqual(FILTERS);
    expect(config.dateWindow).toEqual({ mode: 'relative', days: 1 });
  });

  it('leaves the stored filter bar of a Personal dashboard to its own auto-save', () => {
    const config = configForSave(dashboard(), changes);
    expect(config.filters).toEqual({ subscriptions: [] });
    expect(config.dateWindow).toBeUndefined();
  });
});

describe('the line on a Shared dashboard', () => {
  it('says filter changes are not saved', () => {
    expect(SHARED_FILTERS_NOTE).toMatch(/not saved/);
  });
});

describe('the body of a rename', () => {
  it('carries the revision of the copy the page holds, so a rename from a stale copy is refused', () => {
    expect(renameBody(dashboard({ revision: 7 }), 'New name')).toEqual({ name: 'New name', revision: 7 });
  });
});

describe('saveDashboardEdits', () => {
  const body = { name: 'Taken', config: { widgets: [] } };

  it('puts the body with the revision and the copy it was sent', async () => {
    const current = dashboard();
    const saved = dashboard({ revision: 8 });
    const fetchImpl = answer(200, saved);
    expect(await saveDashboardEdits(current, body, fetchImpl)).toEqual({ kind: 'saved', dashboard: saved });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/dashboards/dash-1');
    expect(JSON.parse(init.body as string)).toEqual({ ...body, revision: 7, opened: current.config });
  });

  it('shows a stale base as the reload notice', async () => {
    const outcome = await saveDashboardEdits(dashboard(), body, answer(409, { error: STALE_DASHBOARD_MESSAGE }));
    expect(outcome).toEqual({ kind: 'stale', message: STALE_DASHBOARD_MESSAGE });
  });

  it('shows a name clash as an error, not as the reload notice that throws away edits', async () => {
    const outcome = await saveDashboardEdits(dashboard(), body, answer(409, { error: 'A dashboard named "Taken" already exists.' }));
    expect(outcome).toEqual({ kind: 'failed', message: 'A dashboard named "Taken" already exists.' });
  });

  it('shows any other refusal as an error', async () => {
    expect(await saveDashboardEdits(dashboard(), body, answer(400, { error: UNSEEN_VALUE_MESSAGE })))
      .toEqual({ kind: 'failed', message: UNSEEN_VALUE_MESSAGE });
    expect(await saveDashboardEdits(dashboard(), body, answer(500, {})))
      .toEqual({ kind: 'failed', message: 'Failed to save the dashboard.' });
  });

  it('shows a rejected fetch as an error instead of throwing', async () => {
    const thrown = vi.fn(async () => { throw new Error('offline'); });
    expect(await saveDashboardEdits(dashboard(), body, thrown as unknown as typeof fetch))
      .toEqual({ kind: 'failed', message: 'Failed to save the dashboard.' });
  });
});

describe('DashboardWrites: the writes one page makes to its own dashboard', () => {
  /** A fake server: it holds the revision and answers 409 to a write based on any other one. */
  function server(start: number) {
    let revision = start;
    const seen: number[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const sent = JSON.parse(init!.body as string) as { revision: number };
      seen.push(sent.revision);
      await new Promise(r => setTimeout(r, 5));
      if (sent.revision !== revision) return new Response(JSON.stringify({ error: STALE_DASHBOARD_MESSAGE }), { status: 409 });
      revision += 1;
      return new Response(JSON.stringify(dashboard({ revision })), { status: 200 });
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, seen };
  }

  it('sends the revision a write before it moved, not the one the page held when the write was planned', async () => {
    const { fetchImpl, seen } = server(7);
    const writes = new DashboardWrites(dashboard());
    // The auto-refresh save and the filter auto-save are both planned against revision 7.
    const refresh = writes.run(latest => saveDashboardEdits(latest, editBody(), fetchImpl));
    const filters = writes.run(latest => autoSaveFilters(ME, latest, FILTERS, WINDOW, fetchImpl));
    expect((await refresh).kind).toBe('saved');
    expect((await filters).kind).toBe('saved');
    expect(seen).toEqual([7, 8]);
    expect(writes.current.revision).toBe(9);
  });

  it('does not send a second filter save while the first is in flight', async () => {
    const { fetchImpl, seen } = server(7);
    const writes = new DashboardWrites(dashboard());
    const first = writes.run(latest => autoSaveFilters(ME, latest, FILTERS, WINDOW, fetchImpl));
    const second = writes.run(latest => autoSaveFilters(ME, latest, { ...FILTERS, tags: ['t'] }, WINDOW, fetchImpl));
    expect([(await first).kind, (await second).kind]).toEqual(['saved', 'saved']);
    expect(seen).toEqual([7, 8]);
  });

  it('still reports a stale base when someone else moved the revision', async () => {
    const { fetchImpl } = server(9);
    const writes = new DashboardWrites(dashboard());
    expect((await writes.run(latest => autoSaveFilters(ME, latest, FILTERS, WINDOW, fetchImpl))).kind).toBe('stale');
    expect(writes.current.revision).toBe(7);
  });

  it('runs a write after one that failed', async () => {
    const { fetchImpl } = server(7);
    const writes = new DashboardWrites(dashboard());
    const failed = writes.run(async () => { throw new Error('offline'); }).catch(() => 'threw');
    const next = writes.run(latest => autoSaveFilters(ME, latest, FILTERS, WINDOW, fetchImpl));
    expect(await failed).toBe('threw');
    expect((await next).kind).toBe('saved');
  });

  it('takes a copy the page adopted from elsewhere, such as a hand-over, as the base of the next write', async () => {
    const { fetchImpl, seen } = server(12);
    const writes = new DashboardWrites(dashboard());
    writes.adopt(dashboard({ revision: 12 }));
    await writes.run(latest => autoSaveFilters(ME, latest, FILTERS, WINDOW, fetchImpl));
    expect(seen).toEqual([12]);
  });
});

function editBody() { return { name: 'D', config: { widgets: [] } }; }
