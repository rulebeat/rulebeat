/**
 * #274: where a person's trend is read from, and what the trend widget says when there is none.
 */
import { describe, expect, it } from 'vitest';
import { buildAccess, everythingAccess, NO_ACCESS, parseScope, type Access } from '@/lib/access-model';
import { trendScopeOf, trendUnavailableMessage } from '@/lib/trend-scope';

const SUB_ONE = '00000000-0000-0000-0000-00000000000a';
const SUB_TWO = '00000000-0000-0000-0000-00000000000b';
const GROUP = '/providers/Microsoft.Management/managementGroups/mg-example';

const holding = (paths: string[], subscriptions?: string[]): Access =>
  buildAccess(
    paths.map(path => ({ tenantId: 't', scope: parseScope(path)!, role: 'viewer' as const })),
    'manual',
    subscriptions ? [{ tenantId: 't', path: GROUP, role: 'viewer', groups: ['mg-example'], subscriptions }] : [],
  );

describe('trendScopeOf', () => {
  it('serves Everything from the install-wide row, or from the one subscription the filter names', () => {
    expect(trendScopeOf(everythingAccess('admin'), undefined)).toEqual({ available: true, subscriptionId: undefined });
    expect(trendScopeOf(everythingAccess('editor'), [SUB_TWO])).toEqual({ available: true, subscriptionId: SUB_TWO });
    expect(trendScopeOf(everythingAccess('editor'), [SUB_ONE, SUB_TWO])).toEqual({ available: true, subscriptionId: undefined });
  });

  it('gives a person with no whole subscription the reason, whatever the filter', () => {
    const resourceGroup = holding([`/subscriptions/${SUB_ONE}/resourceGroups/rg-one`]);
    const none = { available: false, reason: 'no-whole-subscription' };
    expect(trendScopeOf(resourceGroup, undefined)).toEqual(none);
    expect(trendScopeOf(resourceGroup, [SUB_ONE])).toEqual(none);
    expect(trendScopeOf(holding(['@directory']), undefined)).toEqual(none);
    expect(trendScopeOf(NO_ACCESS, undefined)).toEqual(none);
  });

  it('serves a person on one subscription from its rows, with or without the filter', () => {
    const access = holding([`/subscriptions/${SUB_ONE}`]);
    expect(trendScopeOf(access, undefined)).toEqual({ available: true, subscriptionId: SUB_ONE });
    expect(trendScopeOf(access, [SUB_ONE.toUpperCase()])).toEqual({ available: true, subscriptionId: SUB_ONE.toUpperCase() });
  });

  it('serves a person on one subscription and a resource group inside it from the subscription', () => {
    const access = holding([`/subscriptions/${SUB_ONE}`, `/subscriptions/${SUB_ONE}/resourceGroups/rg-one`]);
    expect(trendScopeOf(access, undefined)).toEqual({ available: true, subscriptionId: SUB_ONE });
  });

  it('asks for a choice when what they hold is wider than the one subscription', () => {
    const choose = { available: false, reason: 'choose-subscription' };
    expect(trendScopeOf(holding([`/subscriptions/${SUB_ONE}`, '@directory']), undefined)).toEqual(choose);
    expect(trendScopeOf(holding([`/subscriptions/${SUB_ONE}`, `/subscriptions/${SUB_TWO}/resourceGroups/rg-one`]), undefined)).toEqual(choose);
    expect(trendScopeOf(holding([`/subscriptions/${SUB_ONE}`, `/subscriptions/${SUB_TWO}`]), undefined)).toEqual(choose);
  });

  it('asks a management group Viewer to choose, and serves the one subscription they filter to', () => {
    const access = holding([GROUP], [SUB_ONE, SUB_TWO]);
    expect(trendScopeOf(access, undefined)).toEqual({ available: false, reason: 'choose-subscription' });
    expect(trendScopeOf(access, [SUB_ONE, SUB_TWO])).toEqual({ available: false, reason: 'choose-subscription' });
    expect(trendScopeOf(access, [SUB_TWO])).toEqual({ available: true, subscriptionId: SUB_TWO });
  });

  it('asks for a choice when the filter names a subscription they do not hold whole', () => {
    expect(trendScopeOf(holding([`/subscriptions/${SUB_ONE}`]), [SUB_TWO])).toEqual({ available: false, reason: 'choose-subscription' });
  });

  it('asks for a choice from a management group holding one subscription, since findings placed at the group lie outside it', () => {
    expect(trendScopeOf(holding([GROUP], [SUB_ONE]), undefined)).toEqual({ available: false, reason: 'choose-subscription' });
  });
});

describe('trendUnavailableMessage', () => {
  it('tells a person with no whole subscription that history is kept per subscription', () => {
    const message = trendUnavailableMessage('no-whole-subscription');
    expect(message.title).toBe('Trend history is kept per subscription');
    expect(message.detail).toContain('no whole subscription');
  });

  it('tells a person with several to choose one', () => {
    const message = trendUnavailableMessage('choose-subscription');
    expect(message.title).toBe('Trend history is kept per subscription');
    expect(message.detail).toContain('Choose one subscription');
  });
});
