/**
 * The per-item half of who may do what with a dashboard or a saved view (ADR 0012). `requireRole` has
 * already said the person may act at all; this says whether they may act on this item, from its owner and
 * its visibility (the rules are in `lib/item-access-model.ts`):
 *
 * - someone else's Personal item is answered exactly like an unknown id, an Admin included;
 * - your own Personal item needs `*:personal`, your own Shared item `*:write`, anyone else's Shared item
 *   (an ownerless one too) `*:manage`.
 *
 * Opening a Shared item asks nothing more than `read`. Every dashboard and view route calls this, so the
 * check lives here once.
 */
import { NextResponse } from 'next/server';
import type { Access } from '@/lib/access-model';
import { canOpenItem, mayChangeItem, mayChangeVisibility, mayTransferItem, type ItemKind, type OwnedItem } from '@/lib/item-access-model';

export { canOpenItem, openableItems, type ItemKind, type OwnedItem } from '@/lib/item-access-model';

export interface ItemActor { id: string; access: Access }

/** The one answer for an unknown id and for someone else's Personal item. */
export const itemNotFound = (): NextResponse => NextResponse.json({ error: 'Not found' }, { status: 404 });

/**
 * Null when the person may do `intent` to `item`, else the response to return. A missing item is a 404
 * like someone else's Personal one; an item the person may open but not do that to is a 403. `share` and
 * `unshare` change who sees the item, not its content (`mayChangeVisibility`); `hand-over` and `take-over` change
 * who owns it (`mayTransferItem`).
 */
export function guardItem(actor: ItemActor, kind: ItemKind, item: OwnedItem | null, intent: 'open' | 'change' | 'share' | 'unshare' | 'hand-over' | 'take-over'): NextResponse | null {
  if (!item || !canOpenItem(actor, item)) return itemNotFound();
  if (intent === 'open') return null;
  const allowed = intent === 'change' ? mayChangeItem(actor, kind, item)
    : intent === 'share' || intent === 'unshare' ? mayChangeVisibility(actor, kind, item, intent)
    : mayTransferItem(actor, kind, item, intent);
  return allowed ? null : NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}
