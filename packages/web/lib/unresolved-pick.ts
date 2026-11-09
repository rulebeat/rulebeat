/**
 * The pick the upgrade writes into a Scope filter for an old value that names no Scope (ADR 0015). Kept apart
 * from lib/scope-picks.ts so the start-up step that writes it imports nothing that reaches for `@/`.
 *
 * It is no Scope path, so a pick written as one matches nothing, and it keeps the old filter's own words so it
 * can be shown: a resource group name no finding or scan record pairs with a subscription, and a resource group
 * under the Directory.
 */
export const UNRESOLVED_PICK_PREFIX = 'unresolved:';

export function unresolvedPick(text: string): string {
  return `${UNRESOLVED_PICK_PREFIX}${text}`;
}

export function isUnresolvedPick(pick: string): boolean {
  return pick.startsWith(UNRESOLVED_PICK_PREFIX);
}

/** What an unresolved pick is called: the old filter's own words, without the prefix. */
export function unresolvedLabel(pick: string): string {
  const text = pick.slice(UNRESOLVED_PICK_PREFIX.length);
  if (text.startsWith('resourceGroup/')) return `Resource group ${text.slice('resourceGroup/'.length)}`;
  if (text.startsWith('@directory/')) return `Resource group ${text.slice('@directory/'.length)} in Directory`;
  return text;
}
