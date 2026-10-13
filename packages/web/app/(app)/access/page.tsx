import { notFound } from 'next/navigation';
import { Header } from '@/components/layout/header';
import { getCurrentUser } from '@/lib/api-auth';
import { can } from '@/lib/rbac';
import { listUsersWithAccess, ownAccessOf, resolveAccess } from '@/lib/access';
import { listUserIdsWithPassword } from '@/lib/db/local-accounts';
import { isDemoMode } from '@/lib/demo';
import { AccessClient } from './access-client';
import { OwnAccessSection } from './own-access-section';

export default async function AccessPage() {
  const user = await getCurrentUser();
  // No session has no page. A signed-in person who does not manage users sees their own access and
  // nothing else: the user list and the password ids are loaded only below, for the role that uses them.
  if (!user) notFound();

  if (!can(user.role, 'users:manage')) {
    return (
      <>
        <Header title="Access" description="What you can see in RuleBeat, and the Role you have at each" />
        <main className="flex-1 p-8">
          <div className="max-w-4xl">
            <OwnAccessSection own={ownAccessOf(user, await resolveAccess(user))} />
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <Header title="Access" description="Who can sign in to RuleBeat, and what each person can do" />
      <main className="flex-1 p-8">
        <AccessClient
          initialUsers={await listUsersWithAccess()}
          initialUsersWithPassword={await listUserIdsWithPassword()}
          currentUserId={user.id}
          demo={await isDemoMode()}
        />
      </main>
    </>
  );
}
