/**
 * What the share and unshare routes and their screens say (ADR 0012): the confirmation that spells out what
 * becomes visible, and the refusals the server answers 409 with. Pure, so the console and the routes read the
 * same words. The dashboard confirmation names widget titles because a dashboard carries them; a saved view has
 * only a name and its search text.
 */
import type { ItemKind } from '@/lib/item-access-model';

const NOUN: Record<ItemKind, string> = { dashboard: 'dashboard', view: 'saved view' };

/** The question a Share asks before anything becomes visible. */
export function shareConfirmation(kind: ItemKind, name: string): string {
  const visible = kind === 'dashboard' ? 'name, description, widget titles and search text' : 'name and search text';
  return `Share ${name} with everyone on this install? Its ${visible} will be visible to everyone, and its name will appear in the audit log.`;
}

/** The 409 for a share or unshare the item's current state no longer allows, because it changed after the page loaded. */
export function staleStateMessage(kind: ItemKind): string {
  return `This ${NOUN[kind]} has changed since this page loaded. Reload the page and try again.`;
}

/** The 409 for an unshare of an item with no owner: nobody's Personal list can take it back. */
export const TAKE_OVER_BEFORE_UNSHARING = 'Take this over before unsharing it';

/** The 400 for a hand-over to someone who cannot be given the item. One message for every reason, so it says nothing about the person. */
export const NOT_ELIGIBLE_TO_OWN = 'That person cannot take this over. Choose someone else.';
