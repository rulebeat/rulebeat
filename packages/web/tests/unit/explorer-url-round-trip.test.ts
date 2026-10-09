/**
 * The address is the explorer's state: a /scans link opens the same view it always did, the explorer
 * reads the server with exactly the params the address carries, and a saved view's query opens the
 * view it was saved from. Driven from the page (`searchParams` in, `initialView` out) through the
 * functions the explorer writes its address and its reads with.
 */
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createUser } from '@/lib/db/users';
import { explorerAddress, viewQuery } from '@/lib/explorer-session';
import { viewFromSearchParams, type View } from '@/lib/finding-view';
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
  return { view: props.initialView as View, savedViewId: props.initialSavedViewId as string | undefined };
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
  it('keeps the open saved view, and drops it when none is open', async () => {
    const { view, savedViewId } = await open('tab=results&view=saved-1&severity=high');
    expect(savedViewId).toBe('saved-1');
    expect(pairs(explorerAddress(view, { extraParams: { tab: 'results' }, viewId: savedViewId }))).toEqual(
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
