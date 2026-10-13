import { Header } from '@/components/layout/header';
import { loadSuppressions } from '@/lib/suppressions';
import { getCurrentUser } from '@/lib/api-auth';
import { resolveAccess } from '@/lib/access';
import { NO_ACCESS } from '@/lib/access-model';
import { can } from '@/lib/rbac';
import { SuppressionsClient } from './suppressions-client';

export default async function SuppressionsPage() {
  const user = await getCurrentUser();
  const suppressions = await loadSuppressions(user ? await resolveAccess(user) : NO_ACCESS);
  return (
    <>
      <Header title="Suppressions" description="Findings you have intentionally acknowledged" />
      <main className="flex-1 p-8">
        <SuppressionsClient
          initialSuppressions={suppressions}
          canEdit={can(user?.role ?? 'viewer', 'suppressions:write')}
        />
      </main>
    </>
  );
}
