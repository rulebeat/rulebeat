/**
 * What removing a person does to the dashboards and saved views they own (ADR 0012), as one sentence for the
 * confirmation and the audit entry. Counts only: no name of an item ever appears, since a Personal item's
 * name is its owner's alone. Pure, so the console and the route say the same thing.
 */
/** How many dashboards and saved views a person owns, by visibility. Counts only, never names. */
export interface OwnedItemCounts {
  personalDashboards: number;
  sharedDashboards: number;
  personalViews: number;
  sharedViews: number;
}

/** What removing the person does with what they own. */
export function effectOfRemoving(counts: OwnedItemCounts | undefined): OwnedItemsEffect {
  return {
    deletedDashboards: counts?.personalDashboards ?? 0,
    deletedViews: counts?.personalViews ?? 0,
    releasedDashboards: counts?.sharedDashboards ?? 0,
    releasedViews: counts?.sharedViews ?? 0,
  };
}

export interface OwnedItemsEffect {
  deletedDashboards: number;
  deletedViews: number;
  releasedDashboards: number;
  releasedViews: number;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

function listOf(parts: string[]): string {
  return parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The sentence, or an empty string when the person owns nothing. */
export function ownedItemsSentence(effect: OwnedItemsEffect): string {
  const deleted = [
    effect.deletedDashboards > 0 && plural(effect.deletedDashboards, 'Personal dashboard'),
    effect.deletedViews > 0 && plural(effect.deletedViews, 'Personal saved view'),
  ].filter((p): p is string => !!p);
  const released = [
    effect.releasedDashboards > 0 && plural(effect.releasedDashboards, 'Shared dashboard'),
    effect.releasedViews > 0 && plural(effect.releasedViews, 'Shared saved view'),
  ].filter((p): p is string => !!p);
  const sentences: string[] = [];
  if (deleted.length > 0) sentences.push(`${listOf(deleted)} will be deleted.`);
  if (released.length > 0) sentences.push(`${listOf(released)} will stay Shared with no owner.`);
  return sentences.join(' ');
}

/** The same sentence in the past tense, for the audit entry. */
export function ownedItemsAuditSentence(effect: OwnedItemsEffect): string {
  return ownedItemsSentence(effect).replace(/ will be deleted\./, ' deleted.').replace(/ will stay Shared with no owner\./, ' left Shared with no owner.');
}
