'use client';

import type { AppUserWithAccess } from '@/lib/access';
import { LockedSurface } from '@/components/layout/locked-surface';
import type { HierarchyView } from '@/lib/management-group-tree';
import type { OwnedItemCounts } from '@/lib/owned-items-copy';
import { ManagementGroupsSection } from './management-groups-section';
import { UsersSection } from './users-section';

export function AccessClient({
  initialUsers,
  initialUsersWithPassword,
  ownedItems,
  currentUserId,
  initialHierarchy,
  demo = false,
}: {
  initialUsers: AppUserWithAccess[];
  initialUsersWithPassword: string[];
  /** What each person owns, by person id, for the removal confirmation. */
  ownedItems?: Record<string, OwnedItemCounts>;
  currentUserId: string;
  /** RuleBeat's copy of the management group tree and how its last refresh went. */
  initialHierarchy: HierarchyView;
  /** A Demo: the Users lock message shows and every control inside is disabled. */
  demo?: boolean;
}) {
  return (
    <div className="max-w-5xl space-y-6">
      <LockedSurface demo={demo} action="users:manage">
        <UsersSection
          initialUsers={initialUsers}
          initialUsersWithPassword={initialUsersWithPassword}
          ownedItems={ownedItems}
          currentUserId={currentUserId}
        />
        <ManagementGroupsSection initial={initialHierarchy} />
      </LockedSurface>
    </div>
  );
}
