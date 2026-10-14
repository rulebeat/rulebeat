/**
 * Which posture snapshot rows a person may be given for a trend (#274). Snapshots are recorded per
 * category and per subscription and are install-wide, so only a person on Everything may read the row
 * that spans every subscription. Anyone else gets one subscription's rows, and only a subscription they
 * hold whole, because a snapshot has no resource group grain and per-subscription rows cannot be added
 * up (each rule's pass or fail would need evaluating across the union). Pure and client-safe.
 */
import { wholeSubscriptionIds, type Access } from './access-model';

/** Why a trend is not drawn: the person holds no whole subscription, or holds more than one thing and
 *  has not chosen the one subscription the history is kept for. */
export type TrendReason = 'no-whole-subscription' | 'choose-subscription';

export type TrendScope =
  | { available: true; subscriptionId: string | undefined }
  | { available: false; reason: TrendReason };

/**
 * Where the trend of `subscriptionFilter` is read from for `access`:
 *
 *  - Everything: the filter's single subscription, else the install-wide row.
 *  - No whole subscription: unavailable, whatever the filter.
 *  - A filter naming exactly one subscription held whole: that subscription's rows.
 *  - No filter: served only when everything held lies in one whole subscription (no Directory, no
 *    management group Scope, every resource group inside it).
 *  - Anything else: unavailable until one subscription is chosen.
 */
export function trendScopeOf(access: Access, subscriptionFilter: readonly string[] | undefined): TrendScope {
  const filter = subscriptionFilter ?? [];
  if (access.everything) return { available: true, subscriptionId: filter.length === 1 ? filter[0] : undefined };

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
  return reason === 'no-whole-subscription'
    ? {
        title: 'Trend history is kept per subscription',
        detail: 'Your Access holds no whole subscription, so there is no history to draw. The current numbers above are live and cover your Scopes.',
      }
    : {
        title: 'Trend history is kept per subscription',
        detail: 'Your Access spans more than one subscription. Choose one subscription in the filter bar to see its trend.',
      };
}
