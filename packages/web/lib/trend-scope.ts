/**
 * Which posture snapshot rows a person may be given for a trend (#274). Snapshots are recorded per
 * category and per subscription and are install-wide, so only a person on Everything may read the row
 * that spans every subscription. Anyone else gets one subscription's rows, and only a subscription they
 * hold whole, because a snapshot has no resource group grain and per-subscription rows cannot be added
 * up (each rule's pass or fail would need evaluating across the union). Pure and client-safe.
 */
import { wholeSubscriptionIds, type Access } from './access-model';
import type { WidgetFilters } from './dashboard-filters';
import { DIRECTORY_SUBSCRIPTION } from './placement';

/**
 * Which dashboard filters a stored trend point can honour. A point is recorded per category and per
 * level (the install, one subscription, the Directory) and carries no filter, so a trend, a baseline and
 * a delta are served only under the filters marked 'trend'; any other would compare a filtered live
 * number with an unfiltered point. Declared over every key of `WidgetFilters`, so adding a filter fails
 * the type check until someone decides which it is. New vs Fixed and Activity occurrences read live
 * finding timestamps and are outside this gate.
 */
export const TREND_FILTER_SUPPORT = {
  categories: 'trend',
  subscriptions: 'trend',
  resourceGroups: 'unavailable',
  tags: 'unavailable',
  severities: 'unavailable',
  ruleIds: 'unavailable',
  dateWindow: 'trend',
} as const satisfies Record<keyof WidgetFilters, 'trend' | 'unavailable'>;

/**
 * Whether `filters` leaves a trend, a baseline and a delta meaningful: no filter marked 'unavailable'
 * is set, and the subscriptions filter names at most one value (the Directory is one). Whether that one
 * value is a level this person can be served is decided by `trendScopeOf`.
 */
export function trendAllowedFor(filters: WidgetFilters): boolean {
  for (const key of Object.keys(TREND_FILTER_SUPPORT) as Array<keyof typeof TREND_FILTER_SUPPORT>) {
    if (TREND_FILTER_SUPPORT[key] !== 'unavailable') continue;
    const value = filters[key];
    if (Array.isArray(value) && value.length > 0) return false;
  }
  return (filters.subscriptions?.length ?? 0) <= 1;
}

/** Why a trend is not drawn: the person holds no whole subscription and not the Directory, or holds more
 *  than one thing and has not chosen the one level the history is kept for. */
export type TrendReason = 'no-whole-subscription' | 'choose-subscription';

export type TrendScope =
  | { available: true; subscriptionId: string | undefined }
  | { available: false; reason: TrendReason };

/**
 * Where the trend of `subscriptionFilter` is read from for `access`:
 *
 *  - Everything: the filter's single subscription (or the Directory), else the install-wide row.
 *  - The Directory, for anyone whose Access includes it: served when the filter names only it, and with
 *    no filter to someone whose Access is only the Directory. Decided before the next line.
 *  - No whole subscription: unavailable, whatever the filter.
 *  - A filter naming exactly one subscription held whole: that subscription's rows.
 *  - No filter: served only when everything held lies in one whole subscription (no Directory, no
 *    management group Scope, every resource group inside it).
 *  - Anything else: unavailable until one subscription is chosen.
 */
export function trendScopeOf(access: Access, subscriptionFilter: readonly string[] | undefined): TrendScope {
  const filter = subscriptionFilter ?? [];
  if (access.everything) return { available: true, subscriptionId: filter.length === 1 ? filter[0] : undefined };

  if (access.directory) {
    const named = filter.length === 1 && filter[0]!.toLowerCase() === DIRECTORY_SUBSCRIPTION;
    const onlyDirectory = filter.length === 0 && access.grants.every(({ scope }) => scope.kind === 'directory');
    if (named || onlyDirectory) return { available: true, subscriptionId: DIRECTORY_SUBSCRIPTION };
  }

  const whole = wholeSubscriptionIds(access);
  if (whole.length === 0) return { available: false, reason: 'no-whole-subscription' };

  if (filter.length === 1) {
    return whole.includes(filter[0]!.toLowerCase())
      ? { available: true, subscriptionId: filter[0] }
      : { available: false, reason: 'choose-subscription' };
  }
  if (filter.length > 1) return { available: false, reason: 'choose-subscription' };

  const [only] = whole;
  const heldOutsideIt = access.directory
    || access.grants.some(({ scope }) => {
      if (scope.kind === 'subscription') return scope.path.split('/')[2]!.toLowerCase() !== only;
      if (scope.kind === 'resourceGroup') return scope.path.split('/')[2]!.toLowerCase() !== only;
      return true;
    });
  return whole.length === 1 && !heldOutsideIt
    ? { available: true, subscriptionId: only }
    : { available: false, reason: 'choose-subscription' };
}

/** What the trend widget says when there is no trend to draw, by reason. */
export function trendUnavailableMessage(reason: TrendReason): { title: string; detail: string } {
  const title = 'Trend history is kept per subscription and the Directory';
  return reason === 'no-whole-subscription'
    ? {
        title,
        detail: 'Your Access holds no whole subscription and not the Directory, so there is no history to draw. The current numbers above are live and cover your Scopes.',
      }
    : {
        title,
        detail: 'Your Access spans more than one subscription or the Directory. Choose one subscription, or the Directory, in the filter bar to see its trend.',
      };
}
