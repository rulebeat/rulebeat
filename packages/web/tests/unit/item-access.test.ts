/**
 * ADR 0012 (#355): the per-item owner and visibility check every dashboard and saved view route runs after
 * `requireRole`. The table is written by hand: five people against the five kinds of item.
 */
import { describe, expect, it } from 'vitest';
import { buildAccess, everythingAccess, type Access } from '@/lib/access-model';
import { guardItem } from '@/lib/item-access';
import {
  canOpenItem, DEMOTED_OWNER_NOTE, isDemotedOwner, itemPermissionsFor, mayChangeItemWith, mayChangeVisibilityWith, openableItems, ownerLabel, sectionsOf, type ItemKind, type OwnedItem,
} from '@/lib/item-access-model';
import type { Role } from '@/lib/rbac';

const SUB = '/subscriptions/00000000-0000-0000-0000-000000000000';
const onSubscription = (role: Role): Access => buildAccess([{ tenantId: '', scope: { kind: 'subscription', path: SUB }, role }], 'manual');

const PEOPLE: Record<string, { id: string; access: Access }> = {
  'Viewer': { id: 'me', access: onSubscription('viewer') },
  'scoped Editor': { id: 'me', access: onSubscription('editor') },
  'Editor on Everything': { id: 'me', access: everythingAccess('editor', 'manual') },
  'Admin': { id: 'me', access: everythingAccess('admin', null) },
  'person with no Scope': { id: 'me', access: buildAccess([], 'manual') },
};

const ITEMS: Record<string, OwnedItem> = {
  'own Personal': { owner: { id: 'me' }, visibility: 'personal' },
  'other Personal': { owner: { id: 'someone' }, visibility: 'personal' },
  'own Shared': { owner: { id: 'me' }, visibility: 'shared' },
  'other Shared': { owner: { id: 'someone' }, visibility: 'shared' },
  'ownerless Shared': { owner: null, visibility: 'shared' },
};

const NOT_FOUND = 404;
const FORBIDDEN = 403;
const OK = null;

/** What changing each item answers for each person; opening is `OK` except for another's Personal item. */
const CHANGE: Record<string, Record<string, number | null>> = {
  'Viewer': { 'own Personal': OK, 'other Personal': NOT_FOUND, 'own Shared': FORBIDDEN, 'other Shared': FORBIDDEN, 'ownerless Shared': FORBIDDEN },
  'scoped Editor': { 'own Personal': OK, 'other Personal': NOT_FOUND, 'own Shared': OK, 'other Shared': FORBIDDEN, 'ownerless Shared': FORBIDDEN },
  'Editor on Everything': { 'own Personal': OK, 'other Personal': NOT_FOUND, 'own Shared': OK, 'other Shared': OK, 'ownerless Shared': OK },
  'Admin': { 'own Personal': OK, 'other Personal': NOT_FOUND, 'own Shared': OK, 'other Shared': OK, 'ownerless Shared': OK },
  'person with no Scope': { 'own Personal': OK, 'other Personal': NOT_FOUND, 'own Shared': FORBIDDEN, 'other Shared': FORBIDDEN, 'ownerless Shared': FORBIDDEN },
};

describe('guardItem', () => {
  for (const kind of ['dashboard', 'view'] as ItemKind[]) {
    for (const [person, actor] of Object.entries(PEOPLE)) {
      for (const [label, item] of Object.entries(ITEMS)) {
        it(`${kind}: ${person} changing ${label}`, () => {
          expect(guardItem(actor, kind, item, 'change')?.status ?? null).toBe(CHANGE[person]![label]);
        });
        it(`${kind}: ${person} opening ${label}`, () => {
          expect(guardItem(actor, kind, item, 'open')?.status ?? null).toBe(label === 'other Personal' ? NOT_FOUND : OK);
        });
      }
    }
  }

  // Sharing: your own Personal item needs `*:write`; unsharing needs `*:write` on your own item or `*:manage` on any.
  const SHARE: Record<string, Record<string, number | null>> = {
    'Viewer': { 'own Personal': FORBIDDEN, 'other Personal': NOT_FOUND, 'own Shared': FORBIDDEN, 'other Shared': FORBIDDEN, 'ownerless Shared': FORBIDDEN },
    'scoped Editor': { 'own Personal': OK, 'other Personal': NOT_FOUND, 'own Shared': OK, 'other Shared': FORBIDDEN, 'ownerless Shared': FORBIDDEN },
    'Editor on Everything': { 'own Personal': OK, 'other Personal': NOT_FOUND, 'own Shared': OK, 'other Shared': FORBIDDEN, 'ownerless Shared': FORBIDDEN },
    'Admin': { 'own Personal': OK, 'other Personal': NOT_FOUND, 'own Shared': OK, 'other Shared': FORBIDDEN, 'ownerless Shared': FORBIDDEN },
    'person with no Scope': { 'own Personal': FORBIDDEN, 'other Personal': NOT_FOUND, 'own Shared': FORBIDDEN, 'other Shared': FORBIDDEN, 'ownerless Shared': FORBIDDEN },
  };
  const UNSHARE: Record<string, Record<string, number | null>> = {
    'Viewer': { 'own Personal': FORBIDDEN, 'other Personal': NOT_FOUND, 'own Shared': FORBIDDEN, 'other Shared': FORBIDDEN, 'ownerless Shared': FORBIDDEN },
    'scoped Editor': { 'own Personal': OK, 'other Personal': NOT_FOUND, 'own Shared': OK, 'other Shared': FORBIDDEN, 'ownerless Shared': FORBIDDEN },
    'Editor on Everything': { 'own Personal': OK, 'other Personal': NOT_FOUND, 'own Shared': OK, 'other Shared': OK, 'ownerless Shared': OK },
    'Admin': { 'own Personal': OK, 'other Personal': NOT_FOUND, 'own Shared': OK, 'other Shared': OK, 'ownerless Shared': OK },
    'person with no Scope': { 'own Personal': FORBIDDEN, 'other Personal': NOT_FOUND, 'own Shared': FORBIDDEN, 'other Shared': FORBIDDEN, 'ownerless Shared': FORBIDDEN },
  };
  // Handing over: `*:write` on your own item or `*:manage` on any; taking over: `*:manage` alone. Whether the item is
  // Shared is the write's check, so a Personal item of your own passes the guard and is refused there with a 409.
  const HAND_OVER: Record<string, Record<string, number | null>> = {
    'Viewer': { 'own Personal': FORBIDDEN, 'other Personal': NOT_FOUND, 'own Shared': FORBIDDEN, 'other Shared': FORBIDDEN, 'ownerless Shared': FORBIDDEN },
    'scoped Editor': { 'own Personal': OK, 'other Personal': NOT_FOUND, 'own Shared': OK, 'other Shared': FORBIDDEN, 'ownerless Shared': FORBIDDEN },
    'Editor on Everything': { 'own Personal': OK, 'other Personal': NOT_FOUND, 'own Shared': OK, 'other Shared': OK, 'ownerless Shared': OK },
    'Admin': { 'own Personal': OK, 'other Personal': NOT_FOUND, 'own Shared': OK, 'other Shared': OK, 'ownerless Shared': OK },
    'person with no Scope': { 'own Personal': FORBIDDEN, 'other Personal': NOT_FOUND, 'own Shared': FORBIDDEN, 'other Shared': FORBIDDEN, 'ownerless Shared': FORBIDDEN },
  };
  const TAKE_OVER: Record<string, Record<string, number | null>> = {
    'Viewer': HAND_OVER['Viewer']!,
    'scoped Editor': { 'own Personal': FORBIDDEN, 'other Personal': NOT_FOUND, 'own Shared': FORBIDDEN, 'other Shared': FORBIDDEN, 'ownerless Shared': FORBIDDEN },
    'Editor on Everything': HAND_OVER['Editor on Everything']!,
    'Admin': HAND_OVER['Admin']!,
    'person with no Scope': HAND_OVER['person with no Scope']!,
  };
  for (const kind of ['dashboard', 'view'] as ItemKind[]) {
    for (const [person, actor] of Object.entries(PEOPLE)) {
      for (const [label, item] of Object.entries(ITEMS)) {
        it(`${kind}: ${person} handing over ${label}`, () => {
          expect(guardItem(actor, kind, item, 'hand-over')?.status ?? null).toBe(HAND_OVER[person]![label]);
        });
        it(`${kind}: ${person} taking over ${label}`, () => {
          expect(guardItem(actor, kind, item, 'take-over')?.status ?? null).toBe(TAKE_OVER[person]![label]);
        });
      }
    }
  }
  for (const kind of ['dashboard', 'view'] as ItemKind[]) {
    for (const [person, actor] of Object.entries(PEOPLE)) {
      for (const [label, item] of Object.entries(ITEMS)) {
        it(`${kind}: ${person} sharing ${label}`, () => {
          expect(guardItem(actor, kind, item, 'share')?.status ?? null).toBe(SHARE[person]![label]);
        });
        it(`${kind}: ${person} unsharing ${label}`, () => {
          expect(guardItem(actor, kind, item, 'unshare')?.status ?? null).toBe(UNSHARE[person]![label]);
        });
      }
    }
  }

  it('answers an unknown id and someone else\'s Personal item with the same status and body', async () => {
    const stranger = guardItem(PEOPLE['Admin']!, 'dashboard', ITEMS['other Personal']!, 'open')!;
    const unknown = guardItem(PEOPLE['Admin']!, 'dashboard', null, 'open')!;
    expect(stranger.status).toBe(unknown.status);
    expect(await stranger.json()).toEqual(await unknown.json());
  });

  it('reads a Personal item with no owner as no one\'s', () => {
    const orphan: OwnedItem = { owner: null, visibility: 'personal' };
    expect(canOpenItem({ id: 'me' }, orphan)).toBe(false);
    expect(guardItem(PEOPLE['Admin']!, 'view', orphan, 'change')?.status).toBe(404);
  });
});

describe('openableItems', () => {
  it('keeps Shared items and the person\'s own Personal items, in order', () => {
    const all = Object.values(ITEMS);
    expect(openableItems({ id: 'me' }, all)).toEqual([all[0], all[2], all[3], all[4]]);
  });
});

describe('sectionsOf and ownerLabel', () => {
  const mine = (id: string, visibility: OwnedItem['visibility']) => ({ id, owner: { id: 'me' }, visibility });
  const theirs = (id: string, visibility: OwnedItem['visibility']) => ({ id, owner: { id: 'someone' }, visibility });

  it('puts everything the person owns under Yours, and only the Shared items of others under Shared by others', () => {
    const items = [mine('a', 'personal'), mine('b', 'shared'), theirs('c', 'shared'), theirs('d', 'personal'), { id: 'e', owner: null, visibility: 'shared' as const }];
    const { yours, sharedByOthers } = sectionsOf({ id: 'me' }, items);
    expect(yours.map(i => i.id)).toEqual(['a', 'b']);
    expect(sharedByOthers.map(i => i.id)).toEqual(['c', 'e']);
  });

  it('names an owner by display name, else email, else "No owner"', () => {
    expect(ownerLabel({ displayName: 'Olive Owner', email: 'olive@example.com' })).toBe('Olive Owner');
    expect(ownerLabel({ displayName: '', email: 'olive@example.com' })).toBe('olive@example.com');
    expect(ownerLabel(null)).toBe('No owner');
  });
});

describe('itemPermissionsFor and mayChangeItemWith', () => {
  it('reads what each Role may do from the same map the routes use', () => {
    expect(itemPermissionsFor(PEOPLE['Viewer']!.access, 'dashboard')).toEqual({ personal: true, write: false, manage: false });
    expect(itemPermissionsFor(PEOPLE['scoped Editor']!.access, 'view')).toEqual({ personal: true, write: true, manage: false });
    expect(itemPermissionsFor(PEOPLE['Editor on Everything']!.access, 'view')).toEqual({ personal: true, write: true, manage: true });
    expect(itemPermissionsFor(PEOPLE['person with no Scope']!.access, 'dashboard')).toEqual({ personal: true, write: false, manage: false });
  });

  it('decides the same as the guard for every person and item', () => {
    for (const actor of Object.values(PEOPLE)) {
      const permissions = itemPermissionsFor(actor.access, 'dashboard');
      for (const item of Object.values(ITEMS)) {
        expect(mayChangeItemWith(actor, permissions, item)).toBe(guardItem(actor, 'dashboard', item, 'change') === null);
      }
    }
  });
});

describe('sharing controls from the permissions a page hands down', () => {
  it('decide the same as the guard for sharing and unsharing, for every person and item', () => {
    for (const actor of Object.values(PEOPLE)) {
      const permissions = itemPermissionsFor(actor.access, 'view');
      for (const item of Object.values(ITEMS)) {
        for (const intent of ['share', 'unshare'] as const) {
          expect(mayChangeVisibilityWith(actor, permissions, item, intent)).toBe(guardItem(actor, 'view', item, intent) === null);
        }
      }
    }
  });

  it('tells the owner of a Shared item they can no longer change, and no one else', () => {
    const owned = PEOPLE['Viewer']!;
    const permissions = itemPermissionsFor(owned.access, 'dashboard');
    expect(isDemotedOwner(owned, permissions, ITEMS['own Shared']!)).toBe(true);
    expect(isDemotedOwner(owned, permissions, ITEMS['own Personal']!)).toBe(false);
    expect(isDemotedOwner(owned, permissions, ITEMS['other Shared']!)).toBe(false);
    const editor = PEOPLE['scoped Editor']!;
    expect(isDemotedOwner(editor, itemPermissionsFor(editor.access, 'dashboard'), ITEMS['own Shared']!)).toBe(false);
    expect(DEMOTED_OWNER_NOTE).toBe('Your access no longer lets you change Shared items. Duplicate it, or ask an Admin to take it over.');
  });
});
