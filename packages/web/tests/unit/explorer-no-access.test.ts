/**
 * #272: a person who holds no Scope is told so on the Results, Advisories and Activity tabs. The message
 * is drawn by the explorer itself, on its first render, so it shows whatever the read goes on to answer
 * and never reads as "No findings yet" or "No findings match your filters".
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { holdsNoScope, NO_ACCESS, everythingAccess, buildAccess, parseScope } from '@/lib/access-model';
import { FindingsExplorerClient } from '@/components/findings/findings-explorer-client';
import { emptyView } from '@/lib/finding-view';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => '/scans',
  useSearchParams: () => new URLSearchParams(),
}));

const render = (props: { tab: 'results' | 'advisories' | 'activity'; noAccess: boolean; emptyTitle?: string }) =>
  renderToStaticMarkup(createElement(FindingsExplorerClient, {
    tab: props.tab, categories: [], canSuppress: false, initialView: emptyView(), basePath: '/scans', extraParams: { tab: props.tab },
    mode: 'page', noAccess: props.noAccess, emptyTitle: props.emptyTitle,
  }));

describe('the explorer for a person with no Scope', () => {
  it.each(['results', 'advisories', 'activity'] as const)('says they have been given no access, and to ask an Admin, on the %s tab', (tab) => {
    const html = render({ tab, noAccess: true, emptyTitle: 'No open Advisories' });
    expect(html).toContain('You have been given no access');
    expect(html).toContain('Ask an Admin');
    expect(html).not.toContain('No findings yet');
    expect(html).not.toContain('No findings match your filters');
    expect(html).not.toContain('No open Advisories');
  });

  it('shows the ordinary first screen to a person who holds a Scope', () => {
    const html = render({ tab: 'results', noAccess: false });
    expect(html).not.toContain('You have been given no access');
    expect(html).toContain('Loading findings');
  });
});

describe('who holds no Scope', () => {
  it('is a person with no grants, and nobody else', () => {
    expect(holdsNoScope(NO_ACCESS)).toBe(true);
    expect(holdsNoScope(buildAccess([], 'manual'))).toBe(true);
    expect(holdsNoScope(everythingAccess('viewer', 'manual'))).toBe(false);
    expect(holdsNoScope(buildAccess([{ tenantId: 't', scope: parseScope('@directory')!, role: 'viewer' }], 'manual'))).toBe(false);
  });
});
