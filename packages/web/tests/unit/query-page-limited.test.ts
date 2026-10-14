/**
 * #277: what the Query page shows a person whose written queries are limited. A person whose access is
 * only resource groups gets an explanation in place of the editor, and the Scope control of anyone without
 * Everything offers exactly the subscriptions and management groups they hold.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { QueryPageClient } from '@/components/query/query-client';
import { ScopeTreePicker, limitedScopeTree } from '@/components/rules/scope-tree-picker';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => '/query',
  useSearchParams: () => new URLSearchParams(),
}));

const noop = () => undefined;

describe('the Query page for a person whose access is only resource groups', () => {
  const html = renderToStaticMarkup(createElement(QueryPageClient, { defaultCategoryId: 'security', noSubscription: true }));

  it('says a subscription is needed, and why', () => {
    expect(html).toContain('Queries need a subscription');
    expect(html).toContain('Resource Graph cannot limit a query to a resource group');
    expect(html).toContain('Ask an Admin to give you a subscription');
  });

  it('shows no editor in its place', () => {
    expect(html).not.toContain('>Run</button>');
  });
});

describe('the Query page for a person who can write queries', () => {
  it('shows the editor, not the unavailable state', () => {
    const html = renderToStaticMarkup(createElement(QueryPageClient, { defaultCategoryId: 'security' }));
    expect(html).not.toContain('Queries need a subscription');
    expect(html).toContain('>Run</button>');
  });
});

describe('the Scope control for a person without Everything', () => {
  const held = { subscriptions: ['00000000-0000-0000-0000-00000000000a'], managementGroups: ['mg-example'] };

  it('offers exactly the management groups and subscriptions they hold', () => {
    expect(limitedScopeTree(held).children).toEqual([
      { id: 'mg-example', name: 'mg-example', type: 'managementGroup' },
      { id: '00000000-0000-0000-0000-00000000000a', name: '00000000-0000-0000-0000-00000000000a', type: 'subscription' },
    ]);
  });

  it('says that leaving it empty means all of what they hold', () => {
    const html = renderToStaticMarkup(createElement(ScopeTreePicker, { subscriptions: [], managementGroups: [], onChange: noop, limitTo: held }));
    expect(html).toContain('All of your subscriptions and management groups');
    expect(html).not.toContain('entire tenant');
  });

  it('keeps the tenant-wide wording for Everything', () => {
    const html = renderToStaticMarkup(createElement(ScopeTreePicker, { subscriptions: [], managementGroups: [], onChange: noop }));
    expect(html).toContain('All subscriptions (entire tenant)');
  });
});
