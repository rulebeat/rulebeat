import { notFound } from 'next/navigation';
import { Header } from '@/components/layout/header';
import { getCurrentUser } from '@/lib/api-auth';
import { can } from '@/lib/rbac';
import { ownAccessOf, resolveAccess, withAccess } from '@/lib/access';
import { getUser, listUsers } from '@/lib/db/users';
import { isDemoMode } from '@/lib/demo';
import { signInTenantIsAzureTenant } from '@/lib/sign-in-tenant';
import { OwnAccessSection } from '../../own-access-section';
import { PersonClient } from '../../person-client';

/**
 * One person's Role and access (#311). An Admin edits them here. Anyone else reads the same 404 as for a person who
 * does not exist, except on their own page, which shows their own access read-only, as /access does.
 */
export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const current = await getCurrentUser();
  if (!current) notFound();
  const personId = decodeURIComponent(id);

  if (!can(current.role, 'users:manage')) {
    if (personId !== current.id) notFound();
    return (
      <>
        <Header title="Access" description="What you can see in RuleBeat, and the Role you have at each" />
        <main className="flex-1 p-8">
          <div className="max-w-4xl">
            <OwnAccessSection own={ownAccessOf(current, await resolveAccess(current))} />
          </div>
        </main>
      </>
    );
  }

  const person = await getUser(personId);
  if (!person) notFound();
  const adminCount = (await listUsers()).filter(u => u.role === 'admin').length;

  return (
    <>
      <Header title={person.name ?? person.email} description="Their Role, and what they can access" />
      <main className="flex-1 p-8">
        <PersonClient
          user={await withAccess(person)}
          isLastAdmin={person.role === 'admin' && adminCount === 1}
          isSelf={person.id === current.id}
          signInTenantIsAzureTenant={await signInTenantIsAzureTenant()}
          demo={await isDemoMode()}
        />
      </main>
    </>
  );
}
