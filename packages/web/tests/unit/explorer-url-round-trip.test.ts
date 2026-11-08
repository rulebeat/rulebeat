/**
 * The address is the explorer's state: a /scans link opens the same view it always did, the explorer
 * reads the server with exactly the params the address carries, and a saved view's query opens the
 * view it was saved from. Driven from the page (`searchParams` in, `initialView` out) through the
 * functions the explorer writes its address and its reads with.
 */
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createUser } from '@/lib/db/users';
import { createSavedView, deleteSavedView } from '@/lib/db/saved-views';
import { explorerAddress, viewQuery } from '@/lib/explorer-session';
import { viewFromSearchParams, viewToSearchParams, type View } from '@/lib/finding-view';
import { SAVED_VIEW_UNAVAILABLE, savedViewHref, type OpenSavedView } from '@/lib/saved-view-query';
import { resetDb } from '../helpers/db';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
const { default: ScansPage } = await import('@/app/(app)/scans/page');

beforeEach(async () => {
  await resetDb();
  const viewer = await createUser({ email: 'viewer@example.com', role: 'viewer' });
  if ('error' in viewer) throw new Error(viewer.error);
  mockAuth.mockResolvedValue({ user: { uid: viewer.user.id } });
});

function scansClientProps(node: ReactNode): Record<string, unknown> {
  const queue: ReactNode[] = [node];
  while (queue.length > 0) {
    const next = queue.shift();
    if (Array.isArray(next)) { queue.push(...next); continue; }
    if (!isValidElement(next)) continue;
    const props = (next as ReactElement<Record<string, unknown>>).props;
    if ('activeTab' in props) return props;
    queue.push(props.children as ReactNode);
  }
  throw new Error('ScansClient not rendered');
}

/** What Next hands the page for a query string: a repeated param is an array. */
function searchParamsOf(query: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(query)) {
    const held = out[key];
    out[key] = held === undefined ? value : [...(Array.isArray(held) ? held : [held]), value];
  }
  return out;
}

/** A query as the params it holds, in a fixed order, so two queries compare by what they say. */
const pairs = (query: string) => [...new URLSearchParams(query)].map(([k, v]) => `${k}=${v}`).sort();

async function open(query: string) {
  const props = scansClientProps(await ScansPage({ searchParams: Promise.resolve(searchParamsOf(query)) }));
  return {
    view: props.initialView as View,
    saved: props.openSavedView as OpenSavedView | undefined,
    unavailable: props.savedViewUnavailable as { keepHref: string } | undefined,
  };
}

// Each is a link the explorer itself writes, so it comes back out of the address unchanged.
const LINKS: Record<string, string> = {
  'filters, status, window, search and page':
    'tab=results&category=security&severity=critical%2Chigh&status=new&window=30&q=vm&page=3',
  'a rule, resource group, location and tags on Advisories':
    'tab=advisories&ruleId=rule-1&rg=rg-a&location=westeurope&tags=prod',
  'a custom window': 'tab=results&from=2026-01-01&to=2026-01-31',
  'returned columns, a sort and grouping': 'tab=results&cols=zone%2Csku&sort=rule%3Adesc&group=category%2Clocation&gsort=count%3Adesc',
  'generic fields and a returned-column filter': 'tab=results&f=kind%3Dadvisory&f=firstSeen%3D2026-01-05&rf=zone%3Da%7Cb',
};

describe.each(Object.entries(LINKS))('a link with %s', (_name, query) => {
  it('is written back to the address exactly as it came', async () => {
    const { view } = await open(query);
    expect(pairs(explorerAddress(view, { extraParams: { tab: new URLSearchParams(query).get('tab')! } }))).toEqual(pairs(query));
  });

  it('is read from the server with the params the address carries, plus the tab and nothing else', async () => {
    const { view } = await open(query);
    const tab = new URLSearchParams(query).get('tab') as 'results' | 'advisories';
    expect(pairs(viewQuery({ view, tab, showSuppressed: false }))).toEqual(pairs(query));
  });

  it('opens as the same view from what a saved view keeps of it', async () => {
    const { view } = await open(query);
    const saved = explorerAddress({ ...view, page: 1 });
    expect(viewFromSearchParams(new URLSearchParams(saved))).toEqual({ ...view, page: 1 });
  });
});

describe('the address around the view', () => {
  it('keeps the open saved view in the address, and drops it when none is open', async () => {
    const { view } = await open('tab=results&severity=high');
    expect(pairs(explorerAddress(view, { extraParams: { tab: 'results' }, viewId: 'saved-1' }))).toEqual(
      pairs('tab=results&view=saved-1&severity=high'),
    );
    expect(pairs(explorerAddress(view, { extraParams: { tab: 'results' }, viewId: null }))).toEqual(pairs('tab=results&severity=high'));
  });

  it('leaves a locked category out, since it is the page\'s and not the viewer\'s', async () => {
    const { view } = await open('tab=results&category=security&severity=high');
    expect(pairs(explorerAddress(view, { extraParams: { tab: 'results' }, lockedCategory: 'security' }))).toEqual(pairs('tab=results&severity=high'));
  });

  it('asks the server for suppressed findings only when they are shown', async () => {
    const { view } = await open('tab=results');
    expect(pairs(viewQuery({ view, tab: 'results', showSuppressed: true }))).toEqual(pairs('tab=results&suppressed=1'));
  });
});

describe('a saved view open in the address', () => {
  const SAVED_QUERY = 'category=security&severity=critical%2Chigh&status=all&window=30&q=vm&cols=zone&sort=rule%3Adesc&f=kind%3Dadvisory&rf=zone%3Da';
  let viewId: string;
  let savedAs: View;

  beforeEach(async () => {
    const created = await createSavedView({ name: 'Critical', tab: 'results', query: SAVED_QUERY }, null);
    if (!created.ok) throw new Error(created.reason);
    viewId = created.view.id;
    savedAs = viewFromSearchParams(new URLSearchParams(SAVED_QUERY));
  });

  it('opens from only its tab and id as the saved view, and holds no difference', async () => {
    const { view, saved } = await open(savedViewHref({ id: viewId, tab: 'results' }).split('?')[1]!);
    expect(view).toEqual(savedAs);
    expect(saved).toMatchObject({ id: viewId, revision: 1, view: savedAs });
    expect(explorerAddress(view, { extraParams: { tab: 'results' }, viewId, saved: saved!.view })).toBe(`tab=results&view=${viewId}`);
  });

  it('writes only what the viewer changed, and reads it back as the same effective view', async () => {
    const first = await open(`tab=results&view=${viewId}`);
    const changed: View = {
      ...first.view,
      filters: first.view.filters.filter(f => f.field !== 'row.zone').map(f => (f.field === 'severity' ? { ...f, values: ['low'] } : f)),
      search: '', window: { mode: 'relative', days: 7 }, page: 2,
    };
    const address = explorerAddress(changed, { extraParams: { tab: 'results' }, viewId, saved: first.saved!.view });
    expect(pairs(address)).toEqual(pairs(`tab=results&view=${viewId}&severity=low&window=7&q=&rf=zone&page=2`));
    expect((await open(address)).view).toEqual(changed);
  });

  it('is read from the server with the view\'s id and revision and the same differences', async () => {
    const { view, saved } = await open(`tab=results&view=${viewId}&severity=low`);
    expect(pairs(viewQuery({ view, tab: 'results', showSuppressed: false, saved }))).toEqual(
      pairs(`tab=results&view=${viewId}&rev=1&severity=low`),
    );
  });

  it('opens an old full-copy link as bookmarked, and the explorer then writes it as differences', async () => {
    const old = `tab=results&view=${viewId}&${viewToSearchParams({ ...savedAs, search: 'storage' }).toString()}`;
    const { view, saved } = await open(old);
    expect(view).toEqual({ ...savedAs, search: 'storage' });
    expect(pairs(explorerAddress(view, { extraParams: { tab: 'results' }, viewId, saved: saved!.view }))).toEqual(
      pairs(`tab=results&view=${viewId}&q=storage`),
    );
  });

  it('keeps a locked category out of the address, which is not an Any', async () => {
    const { view, saved } = await open(`tab=results&view=${viewId}`);
    expect(explorerAddress(view, { extraParams: { tab: 'results' }, viewId, saved: saved!.view, lockedCategory: 'security' })).toBe(`tab=results&view=${viewId}`);
  });

  it('shows one notice for a view that never existed, with the link\'s other params kept', async () => {
    const { view, saved, unavailable } = await open('tab=advisories&view=no-such-view&severity=high&q=a');
    expect(saved).toBeUndefined();
    expect(unavailable).toEqual({ keepHref: '/scans?tab=advisories&severity=high&q=a' });
    expect(view).toEqual(viewFromSearchParams(new URLSearchParams('severity=high&q=a')));
    expect(SAVED_VIEW_UNAVAILABLE).toBe('This saved view is not available to you');
  });

  it('shows the same notice and action for a view that was created and then deleted', async () => {
    const created = await createSavedView({ name: 'Short lived', tab: 'advisories', query: 'severity=low' }, null);
    if (!created.ok) throw new Error(created.reason);
    const query = `tab=advisories&view=${created.view.id}&severity=high&q=a`;
    const before = await open(query);
    expect(before.saved).toMatchObject({ id: created.view.id });
    expect(before.unavailable).toBeUndefined();

    expect(await deleteSavedView(created.view.id)).not.toBeNull();

    const { view, saved, unavailable } = await open(query);
    expect(saved).toBeUndefined();
    expect(unavailable).toEqual({ keepHref: '/scans?tab=advisories&severity=high&q=a' });
    expect(view).toEqual(viewFromSearchParams(new URLSearchParams('severity=high&q=a')));
  });

  it('opens plain /scans with no view exactly as before', async () => {
    const { view, saved, unavailable } = await open('tab=results&severity=high');
    expect(saved).toBeUndefined();
    expect(unavailable).toBeUndefined();
    expect(view).toEqual(viewFromSearchParams(new URLSearchParams('severity=high')));
  });
});
