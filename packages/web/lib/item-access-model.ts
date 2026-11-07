/**
 * The pure half of who may do what with a dashboard or a saved view (ADR 0012): the rules that read an
 * item's owner and visibility, with nothing server-only in them so a client component can share them.
 * `lib/item-access.ts` turns them into the guard every route calls.
 */
import { mayAct, type Action } from '@/lib/rbac';
import type { Access } from '@/lib/access-model';
import type { ItemOwner, ItemVisibility } from '@/lib/types';

export type ItemKind = 'dashboard' | 'view';

export interface OwnedItem { owner: Pick<ItemOwner, 'id'> | null; visibility: ItemVisibility }

const ACTIONS: Record<ItemKind, { personal: Action; write: Action; manage: Action }> = {
  dashboard: { personal: 'dashboards:personal', write: 'dashboards:write', manage: 'dashboards:manage' },
  view: { personal: 'views:personal', write: 'views:write', manage: 'views:manage' },
};

/** Is this item the person's own: owned by them. */
export const isOwnItem = (actor: { id: string }, item: OwnedItem): boolean => item.owner?.id === actor.id;

/** May the person open this item at all. A Personal item is only its owner's. */
export function canOpenItem(actor: { id: string }, item: OwnedItem): boolean {
  return item.visibility === 'shared' || isOwnItem(actor, item);
}

/** The items the person may open, in the order given. */
export function openableItems<T extends OwnedItem>(actor: { id: string }, items: readonly T[]): T[] {
  return items.filter(item => canOpenItem(actor, item));
}

/** The action a change to this item needs, or null when the item is not the person's to open. */
export function actionToChange(actor: { id: string }, kind: ItemKind, item: OwnedItem): Action | null {
  if (!canOpenItem(actor, item)) return null;
  const actions = ACTIONS[kind];
  if (item.visibility === 'personal') return actions.personal;
  return isOwnItem(actor, item) ? actions.write : actions.manage;
}

/** May the person change this item (rename, edit, delete). */
export function mayChangeItem(actor: { id: string; access: Access }, kind: ItemKind, item: OwnedItem): boolean {
  const needed = actionToChange(actor, kind, item);
  return needed !== null && mayAct(actor.access, needed);
}

/**
 * May the person change this item's visibility. Sharing is the owner's call: it needs `*:write` on their own
 * item. Unsharing is the owner's too, or anyone who may manage Shared items (`*:manage`). Someone else's
 * Personal item is not the person's to open at all, so it never gets here.
 */
export function mayChangeVisibility(actor: { id: string; access: Access }, kind: ItemKind, item: OwnedItem, intent: 'share' | 'unshare'): boolean {
  if (!canOpenItem(actor, item)) return false;
  const actions = ACTIONS[kind];
  const ownsAndMayWrite = isOwnItem(actor, item) && mayAct(actor.access, actions.write);
  return intent === 'share' ? ownsAndMayWrite : ownsAndMayWrite || mayAct(actor.access, actions.manage);
}

/** What a Shared item's owner is told when their access no longer lets them change it. */
export const DEMOTED_OWNER_NOTE = 'Your access no longer lets you change Shared items. Duplicate it, or ask an Admin to take it over.';

/** Is this the person's own Shared item that they may no longer change: what `DEMOTED_OWNER_NOTE` is shown for. */
export function isDemotedOwner(actor: { id: string }, permissions: ItemPermissions, item: OwnedItem): boolean {
  return item.visibility === 'shared' && isOwnItem(actor, item) && !mayChangeItemWith(actor, permissions, item);
}

/**
 * What a person may do with items of one kind, as a client component needs it: computed on the server from
 * `mayAct`, so a control is off exactly when the route would refuse it.
 */
export interface ItemPermissions {
  /** Create, rename, edit and delete their own Personal items, and duplicate one they can open. */
  personal: boolean;
  /** Change a Shared item they own. */
  write: boolean;
  /** Change a Shared item someone else owns, or that has no owner, and choose the Install default. */
  manage: boolean;
}

export function itemPermissionsFor(access: Access, kind: ItemKind): ItemPermissions {
  const actions = ACTIONS[kind];
  return { personal: mayAct(access, actions.personal), write: mayAct(access, actions.write), manage: mayAct(access, actions.manage) };
}

/** The same decision as `mayChangeItem`, from the permissions a page handed down. */
export function mayChangeItemWith(actor: { id: string }, permissions: ItemPermissions, item: OwnedItem): boolean {
  if (!canOpenItem(actor, item)) return false;
  if (item.visibility === 'personal') return permissions.personal;
  return isOwnItem(actor, item) ? permissions.write : permissions.manage;
}

/** The same decision as `mayChangeVisibility`, from the permissions a page handed down. */
export function mayChangeVisibilityWith(actor: { id: string }, permissions: ItemPermissions, item: OwnedItem, intent: 'share' | 'unshare'): boolean {
  if (!canOpenItem(actor, item)) return false;
  const ownsAndMayWrite = isOwnItem(actor, item) && permissions.write;
  return intent === 'share' ? ownsAndMayWrite : ownsAndMayWrite || permissions.manage;
}

/**
 * The two sections of a list: "Yours" (everything the person owns, Personal or Shared) and "Shared by others"
 * (the Shared items they do not own, an ownerless one included). A Personal item of someone else is in
 * neither: the caller is not meant to hold one.
 */
export function sectionsOf<T extends OwnedItem>(actor: { id: string }, items: readonly T[]): { yours: T[]; sharedByOthers: T[] } {
  return {
    yours: items.filter(item => isOwnItem(actor, item)),
    sharedByOthers: items.filter(item => item.visibility === 'shared' && !isOwnItem(actor, item)),
  };
}

/** Who a Shared item belongs to, as a list shows it: the owner's display name, else their email, else "No owner". */
export function ownerLabel(owner: Pick<ItemOwner, 'displayName' | 'email'> | null): string {
  return owner?.displayName || owner?.email || 'No owner';
}
