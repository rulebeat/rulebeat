import { Header } from '@/components/layout/header';
import { listCategories } from '@/lib/db/categories';
import { getCurrentUser } from '@/lib/api-auth';
import { listUsers } from '@/lib/db/users';
import { listUserIdsWithPassword } from '@/lib/db/local-accounts';
import { can } from '@/lib/rbac';
import { getAzureConnectionStatus } from '@/lib/azure-credential';
import { getSignInStatus } from '@/lib/sign-in-config';
import { listChannels } from '@/lib/db/notification-channels';
import { SettingsClient } from './settings-client';

export default async function SettingsPage() {
  const user = await getCurrentUser();
  const role = user?.role ?? 'viewer';
  const manageUsers = can(role, 'users:manage');
  const manageAzure = can(role, 'azure:manage');
  const manageAuth = can(role, 'auth:manage');
  const manageNotifications = can(role, 'notifications:manage');

  const categories = listCategories();

  return (
    <>
      <Header title="Settings" description="Configure categories, users, and organizational structure" />
      <main className="flex-1 p-8">
        <SettingsClient
          initialCategories={categories}
          role={role}
          currentUserId={user?.id ?? ''}
          initialUsers={manageUsers ? listUsers() : []}
          initialUsersWithPassword={manageUsers ? listUserIdsWithPassword() : []}
          initialAzureStatus={manageAzure ? getAzureConnectionStatus() : null}
          initialSignInStatus={manageAuth ? getSignInStatus() : null}
          initialChannels={manageNotifications ? listChannels() : null}
        />
      </main>
    </>
  );
}
