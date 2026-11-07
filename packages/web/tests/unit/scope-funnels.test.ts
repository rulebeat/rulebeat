/**
 * #388: the Subscription and Resource group column funnels write Scope picks. They list what the findings the
 * viewer sees are placed in, the resource group as an "rg · subscription" pair so the same name in two
 * subscriptions is two choices, and a Directory value writes `@directory`.
 */
import { describe, expect, it, vi } from 'vitest';
import { clearFunnelPicks, funnelOptions, funnelSelected, toggleScopePick } from '@/lib/scope-funnels';
import { commitScopePicks, currentScopePicks, heldPickPaths, requestScopeSet } from '@/lib/scope-picks-write';
import { SCOPE_INLINE_BUDGET } from '@/lib/finding-view';
import type { ScopePickState } from '@/lib/filter-states';

const SUB_A = '00000000-0000-0000-0000-00000000000a';
const SUB_B = '00000000-0000-0000-0000-00000000000b';
const NAMES = { [SUB_A]: 'Alpha', [SUB_B]: 'Beta' };
const PLACEMENTS = {
  subscriptions: [SUB_A, SUB_B, 'directory'],
  resourceGroups: [{ subscription: SUB_B, name: 'rg-one' }, { subscription: SUB_A, name: 'rg-one' }, { subscription: SUB_A, name: 'rg-two' }],
};

describe('funnelOptions', () => {
  it('lists the subscription funnel by subscription name, the Directory as a value of its own', () => {
    expect(funnelOptions('subscription', PLACEMENTS, NAMES)).toEqual([
      { value: `/subscriptions/${SUB_A}`, label: 'Alpha' },
      { value: `/subscriptions/${SUB_B}`, label: 'Beta' },
      { value: '@directory', label: 'Directory' },
    ]);
  });

  it('lists the resource group funnel as rg · subscription pairs, the same name twice when it is in two', () => {
    expect(funnelOptions('resourceGroup', PLACEMENTS, NAMES)).toEqual([
      { value: `/subscriptions/${SUB_A}/resourceGroups/rg-one`, label: 'rg-one · Alpha' },
      { value: `/subscriptions/${SUB_B}/resourceGroups/rg-one`, label: 'rg-one · Beta' },
      { value: `/subscriptions/${SUB_A}/resourceGroups/rg-two`, label: 'rg-two · Alpha' },
    ]);
  });

  it('names a subscription by its id when its name is not known', () => {
    expect(funnelOptions('resourceGroup', { subscriptions: [], resourceGroups: [{ subscription: SUB_A, name: 'rg-one' }] }, {})[0]!.label).toBe(`rg-one · ${SUB_A}`);
  });
});

describe('toggleScopePick', () => {
  it('writes the pick when it is not there and removes it when it is, ignoring case', () => {
    const path = `/subscriptions/${SUB_A}`;
    expect(toggleScopePick(undefined, path)).toEqual([path]);
    expect(toggleScopePick([path], `/subscriptions/${SUB_B}`)).toEqual([path, `/subscriptions/${SUB_B}`]);
    expect(toggleScopePick([path.toUpperCase()], path)).toBeUndefined();
    expect(toggleScopePick(['@directory', path], path)).toEqual(['@directory']);
  });

  it('writes the Directory as @directory', () => {
    expect(toggleScopePick([], '@directory')).toEqual(['@directory']);
  });
});

describe('funnelSelected', () => {
  it('ticks the options a pick stands for, whatever its case, and leaves picks of the other kind alone', () => {
    const picks = [`/subscriptions/${SUB_A.toUpperCase()}`, `/subscriptions/${SUB_A}/resourceGroups/rg-two`, '@directory'];
    expect([...funnelSelected(funnelOptions('subscription', PLACEMENTS, NAMES), picks)].sort()).toEqual([`/subscriptions/${SUB_A}`, '@directory'].sort());
    expect([...funnelSelected(funnelOptions('resourceGroup', PLACEMENTS, NAMES), picks)]).toEqual([`/subscriptions/${SUB_A}/resourceGroups/rg-two`]);
  });
});

describe('clearFunnelPicks', () => {
  const sub = `/subscriptions/${SUB_A}`;
  const rg = `${sub}/resourceGroups/rg-one`;
  const group = '/providers/Microsoft.Management/managementGroups/mg-example';

  it('the Subscription funnel clears subscriptions and the Directory, and keeps the rest', () => {
    expect(clearFunnelPicks('subscription', [sub, '@directory', rg, group])).toEqual([rg, group]);
  });

  it('the Resource group funnel clears resource groups alone', () => {
    expect(clearFunnelPicks('resourceGroup', [sub, rg, group])).toEqual([sub, group]);
  });

  it('leaves no filter when nothing is left', () => {
    expect(clearFunnelPicks('subscription', [sub])).toBeUndefined();
    expect(clearFunnelPicks('resourceGroup', undefined)).toBeUndefined();
  });
});

const held = (value: string): ScopePickState => ({ value, access: 'held', label: value });
const longPicks = Array.from({ length: 40 }, (_, i) => `/subscriptions/${SUB_A}/resourceGroups/resource-group-number-${i}`);

describe('commitScopePicks', () => {
  it('keeps a short list inline', async () => {
    const create = vi.fn();
    expect(await commitScopePicks([`/subscriptions/${SUB_A}`], create)).toEqual({ ok: true, scope: [`/subscriptions/${SUB_A}`], scopeSet: undefined });
    expect(create).not.toHaveBeenCalled();
  });

  it('writes no pick as no filter', async () => {
    expect(await commitScopePicks([], vi.fn())).toEqual({ ok: true, scope: undefined, scopeSet: undefined });
  });

  it('sends a list over the budget to the server and keeps only the hash', async () => {
    expect(longPicks.join(',').length).toBeGreaterThan(SCOPE_INLINE_BUDGET);
    const create = vi.fn(async () => ({ ok: true as const, hash: 'f'.repeat(64) }));
    expect(await commitScopePicks(longPicks, create)).toEqual({ ok: true, scope: undefined, scopeSet: 'f'.repeat(64) });
    expect(create).toHaveBeenCalledWith(longPicks);
  });

  it('keeps the filter as it was and says so when the server refuses the list', async () => {
    const result = await commitScopePicks(longPicks, async () => ({ ok: false as const, message: 'A path in the list is outside the Scopes you hold.' }));
    expect(result).toEqual({ ok: false, message: 'A path in the list is outside the Scopes you hold.' });
  });
});

describe('requestScopeSet', () => {
  it('posts the paths and answers with the server\'s own hash', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ hash: 'a'.repeat(64), count: 2 }), { status: 200 }));
    expect(await requestScopeSet(['/a', '/b'], fetchFn)).toEqual({ ok: true, hash: 'a'.repeat(64) });
    expect(fetchFn).toHaveBeenCalledWith('/api/scope-sets', expect.objectContaining({ method: 'POST', body: JSON.stringify({ paths: ['/a', '/b'] }) }));
  });

  it('returns the server\'s message on a refusal, and a stable one when it cannot be reached', async () => {
    const refused = async () => new Response(JSON.stringify({ error: 'A set holds at most 2000 paths.' }), { status: 400 });
    expect(await requestScopeSet(['/a'], refused)).toEqual({ ok: false, message: 'A set holds at most 2000 paths.' });
    const down = async () => { throw new Error('boom'); };
    expect(await requestScopeSet(['/a'], down)).toEqual({ ok: false, message: 'Could not save this list of Scopes. Try again.' });
  });
});

describe('currentScopePicks', () => {
  it('is the inline list when there is one', () => {
    expect(currentScopePicks(['/a'], undefined, [])).toEqual(['/a']);
    expect(currentScopePicks(undefined, undefined, [])).toEqual([]);
  });

  it('is every pick of the opened set, from the server\'s states, so dropping one never drops the others', () => {
    const states: ScopePickState[] = [held('/a'), { value: '/b', access: 'outside', label: null }, held('/c')];
    expect(currentScopePicks(undefined, 'f'.repeat(64), states)).toEqual(['/a', '/b', '/c']);
  });
});

describe('heldPickPaths', () => {
  it('holds the lower-case paths of the picks held in full, and not those held in part or not at all', () => {
    const states: ScopePickState[] = [held('/A'), { value: '/b', access: 'outside', label: null }, { value: '/c', access: 'narrowed', label: 'c' }];
    expect([...heldPickPaths(states)]).toEqual(['/a']);
  });
});

describe('a set is made of the picks the viewer holds', () => {
  const heldPaths = new Set(longPicks.slice(1).map(p => p.toLowerCase()));

  it('leaves out a pick the viewer holds none of, which matches nothing for them either way', async () => {
    const create = vi.fn(async () => ({ ok: true as const, hash: 'e'.repeat(64) }));
    await commitScopePicks(longPicks, create, heldPaths);
    expect(create).toHaveBeenCalledWith(longPicks.slice(1));
  });

  it('sends the list as it is when no pick is held, and the server\'s refusal is the answer', async () => {
    const create = vi.fn(async () => ({ ok: false as const, message: 'A path in the list is outside the Scopes you hold.' }));
    expect(await commitScopePicks(longPicks, create, new Set())).toEqual({ ok: false, message: 'A path in the list is outside the Scopes you hold.' });
    expect(create).toHaveBeenCalledWith(longPicks);
  });

  it('keeps a short list whole, outside picks included, so the filter still says they match nothing', async () => {
    const picks = [`/subscriptions/${SUB_A}`, `/subscriptions/${SUB_B}`];
    expect(await commitScopePicks(picks, vi.fn(), new Set([picks[0]!.toLowerCase()]))).toEqual({ ok: true, scope: picks, scopeSet: undefined });
  });
});
