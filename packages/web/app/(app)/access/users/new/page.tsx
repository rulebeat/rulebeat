import { notFound } from 'next/navigation';
import { Header } from '@/components/layout/header';
import { getCurrentUser } from '@/lib/api-auth';
import { can } from '@/lib/rbac';
import { isDemoMode } from '@/lib/demo';
import { PersonClient } from '../../person-client';

/** Adding a person (#311): the same form as editing one, with a work email and nothing chosen. Admins only. */
export default async function NewPersonPage() {
  const current = await getCurrentUser();
  if (!current || !can(current.role, 'users:manage')) notFound();
  return (
    <>
      <Header title="Add user" description="Their Role, and what they can access" />
      <main className="flex-1 p-8">
        <PersonClient user={null} isLastAdmin={false} isSelf={false} signInTenantIsAzureTenant={false} demo={await isDemoMode()} />
      </main>
    </>
  );
}
