import { notFound } from 'next/navigation';
import { Header } from '@/components/layout/header';
import { getCurrentUser } from '@/lib/api-auth';
import { can } from '@/lib/rbac';
import { listUsers } from '@/lib/db/users';
import { listUserIdsWithPassword } from '@/lib/db/local-accounts';
import { isDemoMode } from '@/lib/demo';
import { AccessClient } from './access-client';

export default async function AccessPage() {
  const user = await getCurrentUser();
  // notFound() rather than a "forbidden" page: a non-admin has no reason to learn this route exists.
  if (!user || !can(user.role, 'users:manage')) notFound();

  return (
    <>
      <Header title="Access" description="Who can sign in to RuleBeat, and what each person can do" />
      <main className="flex-1 p-8">
        <AccessClient
          initialUsers={await listUsers()}
          initialUsersWithPassword={await listUserIdsWithPassword()}
          currentUserId={user.id}
          demo={await isDemoMode()}
        />
      </main>
    </>
  );
}
