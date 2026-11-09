/**
 * Old `/scans` links that carry `subscription=` and `rg=` (#392): what a legacy value becomes for one viewer. The
 * conversion mapping reads the values into Scope picks and the viewer's Access narrows them, so a value counts as
 * translated only when it reaches a pair the viewer holds. Pure: the pairs on record come in as an index.
 */
import { describe, expect, it } from 'vitest';
import { buildAccess, everythingAccess, parseScope, type Access } from '@/lib/access-model';
import { indexPairs } from '@/lib/db/filter-conversion';
import { translateLegacyScope } from '@/lib/legacy-scope';

const SUB_A = '00000000-0000-0000-0000-00000000000a';
const SUB_B = '00000000-0000-0000-0000-00000000000b';
const PAIRS = indexPairs([
  { subscription_id: SUB_A, resource_group: 'rg-app' },
  { subscription_id: SUB_B, resource_group: 'rg-app' },
  { subscription_id: SUB_A, resource_group: 'rg-data' },
]);

const holding = (...paths: string[]): Access => buildAccess(paths.map(path => ({ tenantId: 't', scope: parseScope(path)!, role: 'viewer' as const })), 'manual');
const EVERYTHING = everythingAccess('admin');
const NONE = { subscriptions: [], resourceGroups: [] };
const sub = (id: string) => `/subscriptions/${id}`;
const group = (id: string, name: string) => `/subscriptions/${id}/resourceGroups/${name}`;

describe('a legacy link whose every value reaches a pair the viewer holds', () => {
  it('turns subscriptions into Scope picks', () => {
    const t = translateLegacyScope(holding(sub(SUB_A), sub(SUB_B)), { subscriptions: [SUB_A, SUB_B], resourceGroups: [] }, PAIRS);
    expect(t).toEqual({ paths: [sub(SUB_A), sub(SUB_B)], outside: NONE, gone: NONE, complete: true });
  });

  it('turns subscriptions with resource group names into their pairs', () => {
    const t = translateLegacyScope(holding(sub(SUB_A)), { subscriptions: [SUB_A], resourceGroups: ['rg-app', 'rg-data'] }, PAIRS);
    expect(t.paths).toEqual([group(SUB_A, 'rg-app'), group(SUB_A, 'rg-data')]);
    expect(t.complete).toBe(true);
  });

  it('turns the reserved directory value into the Directory pick for someone who holds it', () => {
    const t = translateLegacyScope(holding('@directory'), { subscriptions: ['directory'], resourceGroups: [] }, PAIRS);
    expect(t.paths).toEqual(['@directory']);
    expect(t.complete).toBe(true);
  });

  it('is complete for Everything even when a subscription is on no record', () => {
    const t = translateLegacyScope(EVERYTHING, { subscriptions: ['00000000-0000-0000-0000-0000000000ff'], resourceGroups: [] }, PAIRS);
    expect(t.paths).toEqual([sub('00000000-0000-0000-0000-0000000000ff')]);
    expect(t.complete).toBe(true);
  });
});

describe('a resource group name with no subscription', () => {
  it('resolves only to the pairs the viewer holds', () => {
    const t = translateLegacyScope(holding(sub(SUB_B)), { subscriptions: [], resourceGroups: ['RG-APP'] }, PAIRS);
    expect(t.paths).toEqual([group(SUB_B, 'rg-app')]);
    expect(t.complete).toBe(true);
  });

  it('resolves to every pair of that name across the subscriptions the viewer holds', () => {
    const t = translateLegacyScope(holding(sub(SUB_A), sub(SUB_B)), { subscriptions: [], resourceGroups: ['rg-app'] }, PAIRS);
    expect(t.paths).toEqual([group(SUB_A, 'rg-app'), group(SUB_B, 'rg-app')]);
  });

  it('reaches a pair held through a resource group Scope', () => {
    const t = translateLegacyScope(holding(group(SUB_A, 'rg-app')), { subscriptions: [], resourceGroups: ['rg-app'] }, PAIRS);
    expect(t.paths).toEqual([group(SUB_A, 'rg-app')]);
    expect(t.complete).toBe(true);
  });
});

describe('a legacy value that reaches no pair the viewer holds', () => {
  it('is outside the viewer\'s access, never turned into a pick, and the link is not complete', () => {
    const t = translateLegacyScope(holding(sub(SUB_A)), { subscriptions: [SUB_B], resourceGroups: [] }, PAIRS);
    expect(t).toEqual({ paths: [], outside: { subscriptions: [SUB_B], resourceGroups: [] }, gone: NONE, complete: false });
  });

  it('keeps the held values and counts the rest, for a partly held link', () => {
    const t = translateLegacyScope(holding(sub(SUB_A)), { subscriptions: [SUB_A, SUB_B], resourceGroups: [] }, PAIRS);
    expect(t.paths).toEqual([sub(SUB_A)]);
    expect(t.outside.subscriptions).toEqual([SUB_B]);
    expect(t.complete).toBe(false);
  });

  it('counts a name-only group whose pairs the viewer holds none of, and never writes a pair for it', () => {
    const none = translateLegacyScope(holding(group(SUB_B, 'rg-other')), { subscriptions: [], resourceGroups: ['rg-data'] }, PAIRS);
    expect(none.paths).toEqual([]);
    expect(none.outside.resourceGroups).toEqual(['rg-data']);
  });

  it('counts the directory value for someone who does not hold the Directory', () => {
    const t = translateLegacyScope(holding(sub(SUB_A)), { subscriptions: ['directory'], resourceGroups: [] }, PAIRS);
    expect(t.paths).toEqual([]);
    expect(t.outside.subscriptions).toEqual(['directory']);
  });

  it('counts a name that no record pairs with a subscription, and a resource group under the Directory', () => {
    const t = translateLegacyScope(holding(sub(SUB_A)), { subscriptions: [], resourceGroups: ['rg-ghost'] }, PAIRS);
    expect(t.outside.resourceGroups).toEqual(['rg-ghost']);
    expect(t.complete).toBe(false);
    const dir = translateLegacyScope(holding('@directory'), { subscriptions: ['directory'], resourceGroups: ['rg-app'] }, PAIRS);
    expect(dir.paths).toEqual([]);
    expect(dir.complete).toBe(false);
  });

  it('counts a subscription together with a group it holds no pair of', () => {
    const t = translateLegacyScope(holding(group(SUB_A, 'rg-app')), { subscriptions: [SUB_A], resourceGroups: ['rg-app', 'rg-data'] }, PAIRS);
    expect(t.paths).toEqual([group(SUB_A, 'rg-app')]);
    expect(t.outside).toEqual({ subscriptions: [], resourceGroups: ['rg-data'] });
  });
});

describe('a legacy value that no record pairs, for Everything', () => {
  it('is named and gone, not outside anyone\'s access, and the link is not complete', () => {
    const t = translateLegacyScope(EVERYTHING, { subscriptions: [], resourceGroups: ['rg-ghost'] }, PAIRS);
    expect(t).toEqual({ paths: [], outside: NONE, gone: { subscriptions: [], resourceGroups: ['rg-ghost'] }, complete: false });
  });

  it('keeps the pairs a partly matching link reaches, whatever the case of the name', () => {
    const t = translateLegacyScope(EVERYTHING, { subscriptions: [], resourceGroups: ['RG-DATA', 'rg-ghost'] }, PAIRS);
    expect(t.paths).toEqual([group(SUB_A, 'rg-data')]);
    expect(t.gone.resourceGroups).toEqual(['rg-ghost']);
  });
});
