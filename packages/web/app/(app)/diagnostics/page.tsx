import { notFound } from 'next/navigation';
import { Header } from '@/components/layout/header';
import { getCurrentUser } from '@/lib/api-auth';
import { can } from '@/lib/rbac';
import { DiagnosticsClient } from './diagnostics-client';

export default async function DiagnosticsPage() {
  const user = await getCurrentUser();
  if (!user || !can(user.role, 'azure:manage')) notFound();

  return (
    <>
      <Header
        title="Diagnostics"
        description="Azure connectivity, scheduler liveness, and schema cache health"
      />
      <main className="flex-1 p-8">
        <DiagnosticsClient />
      </main>
    </>
  );
}
