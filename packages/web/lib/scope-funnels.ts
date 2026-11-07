/**
 * What the Subscription and Resource group column funnels do on the Scans page (#388). Neither is a filter of its
 * own any more: a tick writes a Scope pick, so the funnel and the Scope picker edit one list. The values come
 * from where the findings the viewer sees are placed, never from the stored tree. Pure and client-safe.
 */
import { DIRECTORY_SCOPE_PATH, parseScope, sameScopePath } from './access-model';
import { DIRECTORY_SUBSCRIPTION } from './placement';
import { resourceGroupScopePath, subscriptionScopePath } from './access-picker';

/** Where the findings a person sees are placed. A subscription value is an id, or the reserved Directory value. */
export interface ScopeFunnelPlacements {
  subscriptions: string[];
  resourceGroups: { subscription: string; name: string }[];
}

export type FunnelKind = 'subscription' | 'resourceGroup';

export interface FunnelOption { value: string; label: string }

const byLabel = (a: FunnelOption, b: FunnelOption) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value);

/**
 * The funnel's choices. `value` is the Scope path the pick is written as. A resource group reads
 * "rg · subscription", so the same name in two subscriptions is two choices. `names` maps a subscription id to
 * its display name; an id it does not know is shown as it is.
 */
export function funnelOptions(kind: FunnelKind, placements: ScopeFunnelPlacements, names: Readonly<Record<string, string>>): FunnelOption[] {
  const named = (id: string) => names[id] ?? names[id.toLowerCase()] ?? id;
  if (kind === 'subscription') {
    return placements.subscriptions
      .map((id): FunnelOption => (id === DIRECTORY_SUBSCRIPTION
        ? { value: DIRECTORY_SCOPE_PATH, label: 'Directory' }
        : { value: subscriptionScopePath(id), label: named(id) }))
      .sort(byLabel);
  }
  return placements.resourceGroups
    .map((g): FunnelOption => ({ value: resourceGroupScopePath(g.subscription, g.name), label: `${g.name} · ${named(g.subscription)}` }))
    .sort(byLabel);
}

/** The options of a funnel that a pick stands for, by the option's own value, in any casing of the pick. */
export function funnelSelected(options: readonly FunnelOption[], picks: readonly string[] | undefined): Set<string> {
  const selected = new Set<string>();
  for (const option of options) {
    if ((picks ?? []).some(pick => sameScopePath(pick, option.value))) selected.add(option.value);
  }
  return selected;
}

/** The picks with `path` added when it is not there and removed when it is. No pick left is no filter. */
export function toggleScopePick(picks: readonly string[] | undefined, path: string): string[] | undefined {
  const current = picks ?? [];
  const next = current.some(pick => sameScopePath(pick, path))
    ? current.filter(pick => !sameScopePath(pick, path))
    : [...current, path];
  return next.length > 0 ? next : undefined;
}

/** The picks without those the funnel writes: for the Subscription funnel the subscriptions and the Directory, for
 *  the Resource group funnel the resource groups. Picks of a management group stay, as the funnel never wrote them.
 *  No pick left is no filter. */
export function clearFunnelPicks(kind: FunnelKind, picks: readonly string[] | undefined): string[] | undefined {
  const written = kind === 'subscription' ? ['subscription', 'directory'] : ['resourceGroup'];
  const kept = (picks ?? []).filter(pick => !written.includes(parseScope(pick)?.kind ?? ''));
  return kept.length > 0 ? kept : undefined;
}
