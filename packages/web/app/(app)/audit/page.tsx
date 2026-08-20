import { notFound } from 'next/navigation';
import { Header } from '@/components/layout/header';
import { getCurrentUser } from '@/lib/api-auth';
import { can } from '@/lib/rbac';
import { listAuditEntries, countAuditEntries } from '@/lib/db/audit';
import { AuditClient, PAGE_SIZE } from './audit-client';

export default async function AuditPage() {
  const user = await getCurrentUser();
  // notFound() rather than a "forbidden" page: a non-admin has no reason to learn this route exists.
  if (!user || !can(user.role, 'audit:read')) notFound();

  return (
    <>
      <Header
        title="Audit log"
        description="Every change made in RuleBeat, and who made it"
      />
      <main className="flex-1 p-8">
        <AuditClient
          initialEntries={listAuditEntries({ limit: PAGE_SIZE })}
          initialTotal={countAuditEntries()}
        />
      </main>
    </>
  );
}
