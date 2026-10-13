import { Header } from '@/components/layout/header';
import { listCategories } from '@/lib/db/categories';
import { getCurrentUser } from '@/lib/api-auth';
import { can } from '@/lib/rbac';
import { getAzureConnectionStatus } from '@/lib/azure-credential';
import { getSignInStatus } from '@/lib/sign-in-config';
import { listChannels } from '@/lib/db/notification-channels';
import { isDemoMode } from '@/lib/demo';
import { SettingsClient } from './settings-client';

export default async function SettingsPage() {
  const user = await getCurrentUser();
  const role = user?.role ?? 'viewer';
  const manageAzure = can(role, 'azure:manage');
  const manageAuth = can(role, 'auth:manage');
  const manageNotifications = can(role, 'notifications:manage');

  const categories = await listCategories();
  const demo = await isDemoMode();

  const initialChannels = manageNotifications ? await listChannels() : null;

  return (
    <>
      <Header title="Settings" description="Appearance, sign-in, the Azure connection, notifications and categories" />
      <main className="flex-1 p-8">
        <SettingsClient
          initialCategories={categories}
          role={role}
          initialAzureStatus={manageAzure ? await getAzureConnectionStatus() : null}
          initialSignInStatus={manageAuth ? await getSignInStatus() : null}
          initialChannels={initialChannels}
          demo={demo}
        />
      </main>
    </>
  );
}
