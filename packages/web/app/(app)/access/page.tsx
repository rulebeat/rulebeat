import { notFound } from 'next/navigation';
import { Header } from '@/components/layout/header';
import { getCurrentUser } from '@/lib/api-auth';
import { can } from '@/lib/rbac';
import { listUsersWithAccess, ownAccessOf, resolveAccess } from '@/lib/access';
import { listUserIdsWithPassword } from '@/lib/db/local-accounts';
import { isDemoMode } from '@/lib/demo';
import { hierarchyResponse } from '@/lib/management-group-response';
import { getArmTenantId } from '@/lib/arm';
import { resolveSignInConfig } from '@/lib/sign-in-config';
import { AccessClient } from './access-client';
import { OwnAccessSection } from './own-access-section';

/**
 * Whether people sign in through the same tenant the Azure connection reads. Only then does the object id RuleBeat
 * holds for someone who signed in with Entra name the same account in Azure, so "Use their sign-in account" is
 * offered. No sign-in configuration, or no Azure connection, is no.
 */
async function signInTenantIsAzureTenant(): Promise<boolean> {
  try {
    const [signIn, azureTenantId] = await Promise.all([resolveSignInConfig(), getArmTenantId()]);
    return signIn !== null && signIn.tenantId.toLowerCase() === azureTenantId.toLowerCase();
  } catch {
    return false;
  }
}

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
          initialHierarchy={await hierarchyResponse()}
          signInTenantIsAzureTenant={await signInTenantIsAzureTenant()}
          demo={await isDemoMode()}
        />
      </main>
    </>
  );
}
