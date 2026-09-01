import { notFound } from 'next/navigation';
import { Header } from '@/components/layout/header';
import { QueryPageClient } from '@/components/query/query-client';
import { listCategories } from '@/lib/db/categories';
import { getCurrentUser } from '@/lib/api-auth';
import { can } from '@/lib/rbac';

export default async function QueryPage() {
  const user = await getCurrentUser();
  if (!can(user?.role ?? 'viewer', 'rules:validate')) notFound();

  const categories = await listCategories();
  const defaultCategoryId = categories[0]?.id ?? '';

  return (
    <>
      <Header
        title="Query"
        description="Run a Resource Graph, Microsoft Graph, or Log Analytics query directly, without saving it as a rule first."
      />
      <main className="flex-1 p-6">
        <QueryPageClient defaultCategoryId={defaultCategoryId} />
      </main>
    </>
  );
}
