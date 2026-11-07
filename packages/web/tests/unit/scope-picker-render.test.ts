/**
 * #388: what the Scope picker draws. A saved view converted to Scope picks opens with those picks ticked on the
 * picker's tree, a pick nested inside another reads "Covered by" it, and a pick the viewer holds nothing of is not
 * on the tree. Rendered on the server, in the style of library-requests-render.test.ts.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ScopePickerTree } from '@/components/filters/shared-filters';
import { everythingAccess } from '@/lib/access-model';
import { viewFromSearchParams } from '@/lib/finding-view';
import { savedViewHref } from '@/lib/saved-view-query';
import { currentScopePicks } from '@/lib/scope-picks-write';
import { buildScopeOptions } from '@/lib/scope-options';
import type { HierarchyStatus, TreeNode } from '@/lib/management-group-tree';

const SUB = '00000000-0000-0000-0000-00000000000a';
const OTHER_SUB = '00000000-0000-0000-0000-00000000000b';
const NODES: TreeNode[] = [
  { id: 'root', kind: 'managementGroup', name: 'Tenant Root Group', parentId: null },
  { id: SUB, kind: 'subscription', name: 'Alpha subscription', parentId: 'root' },
  { id: OTHER_SUB, kind: 'subscription', name: 'Beta subscription', parentId: 'root' },
];
const LISTED: HierarchyStatus = { lastSuccessAt: '2026-06-01T00:00:00.000Z', lastAttemptAt: '2026-06-01T00:00:00.000Z', error: null };
const scopes = buildScopeOptions(everythingAccess('admin'), NODES, LISTED, [{ subscription: SUB, name: 'rg-one' }, { subscription: OTHER_SUB, name: 'rg-two' }]);

const draw = (picks: string[]) => renderToStaticMarkup(createElement(ScopePickerTree, { scopes, picks, onChange: () => undefined }));
/** The checkboxes drawn, by their label: whether each is ticked and whether it is disabled. */
function boxes(markup: string): Record<string, { checked: boolean; disabled: boolean }> {
  const out: Record<string, { checked: boolean; disabled: boolean }> = {};
  for (const tag of markup.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? []) {
    out[/aria-label="([^"]*)"/.exec(tag)![1]!] = { checked: /\schecked(=|\s|>)/.test(tag), disabled: /\sdisabled(=|\s|>)/.test(tag) };
  }
  return out;
}

describe('a converted saved view opens with its Scope picks on the picker', () => {
  const saved = {
    id: 'saved-1', tab: 'results' as const,
    query: new URLSearchParams({ scope: [`/subscriptions/${SUB}`, `/subscriptions/${OTHER_SUB}/resourceGroups/rg-two`].join(',') }).toString(),
  };
  const opened = viewFromSearchParams(new URL(savedViewHref(saved), 'http://localhost').searchParams);

  it('reads the saved view\'s picks from the link that opens it', () => {
    expect(currentScopePicks(opened.scope, opened.scopeSet, [])).toEqual([`/subscriptions/${SUB}`, `/subscriptions/${OTHER_SUB}/resourceGroups/rg-two`]);
  });

  it('ticks them on the tree, and no other node', () => {
    const picks = currentScopePicks(opened.scope, opened.scopeSet, []);
    const drawn = boxes(draw(picks));
    expect(drawn['Alpha subscription']).toEqual({ checked: true, disabled: false });
    expect(drawn['rg-two']).toEqual({ checked: true, disabled: false });
    expect(drawn['Beta subscription']).toEqual({ checked: false, disabled: false });
    expect(drawn['Tenant Root Group']).toEqual({ checked: false, disabled: false });
  });
});

describe('a nested pick reads "Covered by" the pick above it', () => {
  it('shows a resource group under a ticked subscription as covered and not to be ticked again', () => {
    const markup = draw([`/subscriptions/${SUB}`]);
    expect(boxes(markup)['rg-one']).toEqual({ checked: true, disabled: true });
    expect(markup).toContain('Covered by Alpha subscription');
    expect(markup).not.toContain('Covered by Beta subscription');
  });

  it('shows what is under a ticked management group as covered', () => {
    const markup = draw(['/providers/Microsoft.Management/managementGroups/root']);
    const drawn = boxes(markup);
    expect(drawn['Tenant Root Group']).toEqual({ checked: true, disabled: false });
    expect([drawn['Alpha subscription'], drawn['Beta subscription']]).toEqual(Array(2).fill({ checked: true, disabled: true }));
    expect(drawn.Directory).toEqual({ checked: false, disabled: false });
    expect(markup.match(/Covered by Tenant Root Group/g)).toHaveLength(2);
  });
});

describe('a person who holds nothing', () => {
  it('is told so in place of an empty tree', () => {
    const markup = renderToStaticMarkup(createElement(ScopePickerTree, { scopes: { listing: 'listed', directory: false, tree: [] }, picks: [], onChange: () => undefined }));
    expect(markup).toContain('You hold no Scope to filter by.');
  });

  it('is offered the Directory when they hold it, first', () => {
    const markup = renderToStaticMarkup(createElement(ScopePickerTree, { scopes: { listing: 'listed', directory: true, tree: [] }, picks: ['@directory'], onChange: () => undefined }));
    expect(boxes(markup)).toEqual({ Directory: { checked: true, disabled: false } });
  });
});
