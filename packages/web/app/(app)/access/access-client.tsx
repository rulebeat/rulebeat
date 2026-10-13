'use client';

import type { AppUserWithAccess } from '@/lib/access';
import { LockedSurface } from '@/components/layout/locked-surface';
import { UsersSection } from './users-section';

export function AccessClient({
  initialUsers,
  initialUsersWithPassword,
  currentUserId,
  demo = false,
}: {
  initialUsers: AppUserWithAccess[];
  initialUsersWithPassword: string[];
  currentUserId: string;
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
        />
      </LockedSurface>
    </div>
  );
}
