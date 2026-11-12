/**
 * #373: "This saved view no longer exists." is drawn on every screen the Scans page can be on when a read says
 * `view=<id>` no longer opens, not only on the full explorer. The old link to a deleted or someone else's
 * Personal view is dropped from the address either way, so a screen that left the notice out would drop it silently.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FindingsExplorerClient } from '@/components/findings/findings-explorer-client';
import { emptyView } from '@/lib/finding-view';
import { viewQuery } from '@/lib/explorer-session';
import { SAVED_VIEW_GONE_COPY } from '@/lib/held-back';
import type { ViewState } from '@/lib/explorer-session';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => '/scans',
  useSearchParams: () => new URLSearchParams(),
}));

let feed: ViewState | null = null;
vi.mock('@/lib/hooks/use-explorer-session', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/hooks/use-explorer-session')>();
  return { ...original, useStore: (store: Parameters<typeof original.useStore>[0]) => feed ?? original.useStore(store) };
});

const savedViews = {
  tab: 'results' as const, currentUserId: 'me', openId: 'gone-view', onOpen: () => undefined, onUrlWrite: () => undefined,
  permissions: { personal: true, write: false, manage: false },
};

/** The query of the request the page makes for the view it was opened on, which is what an answer must name to count. */
const openedQuery = viewQuery({ view: { ...emptyView(), page: 1 }, tab: 'results', showSuppressed: false, savedViewId: 'gone-view' });

const facets = new Proxy({}, { get: () => [] });
const answer = (extra: object) => ({ status: 'ready', query: openedQuery, data: { total: 0, page: 1, pageCount: 1, items: [], facets, columns: [], ruleRows: [], categories: [], ...extra } }) as unknown as ViewState;

const render = (props: { noAccess?: boolean } = {}) => renderToStaticMarkup(createElement(FindingsExplorerClient, {
  tab: 'results', categories: [], canSuppress: false, initialView: emptyView(), basePath: '/scans', extraParams: { tab: 'results' },
  mode: 'page', noAccess: props.noAccess ?? false, savedViews,
}));

describe('a saved view that no longer opens', () => {
  beforeEach(() => { feed = null; });

  it('is announced on the empty screen, where a tab has no finding at all', () => {
    feed = answer({ viewMissing: true, policyOptions: [] });
    const html = render();
    expect(html).toContain('No findings yet');
    expect(html).toContain(SAVED_VIEW_GONE_COPY);
  });

  it('is announced on the screen of a person with no Scope', () => {
    feed = answer({ viewMissing: true, policyOptions: [] });
    const html = render({ noAccess: true });
    expect(html).toContain('You have been given no access');
    expect(html).toContain(SAVED_VIEW_GONE_COPY);
  });

  it('is not announced when the read opened the view', () => {
    feed = answer({ policyOptions: [] });
    expect(render()).not.toContain(SAVED_VIEW_GONE_COPY);
    expect(render({ noAccess: true })).not.toContain(SAVED_VIEW_GONE_COPY);
  });

  it('is not announced from an answer to an earlier request', () => {
    feed = { ...answer({ viewMissing: true, policyOptions: [] }), query: 'tab=results&something=else' } as ViewState;
    expect(render()).not.toContain(SAVED_VIEW_GONE_COPY);
  });
});
