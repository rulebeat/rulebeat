'use client';

import type { AppUserWithAccess } from '@/lib/access';
import { LockedSurface } from '@/components/layout/locked-surface';
import type { HierarchyView } from '@/lib/management-group-tree';
import { ManagementGroupsSection } from './management-groups-section';
import { UsersSection } from './users-section';

export function AccessClient({
  initialUsers,
  initialUsersWithPassword,
  currentUserId,
  initialHierarchy,
  signInTenantIsAzureTenant = false,
  demo = false,
}: {
  initialUsers: AppUserWithAccess[];
  initialUsersWithPassword: string[];
  currentUserId: string;
  /** RuleBeat's copy of the management group tree and how its last refresh went. */
  initialHierarchy: HierarchyView;
  /** Whether the sign-in tenant is the Azure connection's: "Use their sign-in account" is offered only then. */
  signInTenantIsAzureTenant?: boolean;
  /** A Demo: the Users lock message shows and every control inside is disabled. */
  demo?: boolean;
}) {
  return (
    <div className="max-w-4xl space-y-6">
      <LockedSurface demo={demo} action="users:manage">
        <UsersSection
          initialUsers={initialUsers}
          initialUsersWithPassword={initialUsersWithPassword}
          currentUserId={currentUserId}
          signInTenantIsAzureTenant={signInTenantIsAzureTenant}
        />
        <ManagementGroupsSection initial={initialHierarchy} />
      </LockedSurface>
    </div>
  );
}
