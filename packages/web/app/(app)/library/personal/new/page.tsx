import { notFound } from 'next/navigation';
import { Header } from '@/components/layout/header';
import { RuleNewClient } from '@/components/rules/rule-new-client';
import { Callout } from '@/components/ui/callout';
import { resolveAccess } from '@/lib/access';
import { getCurrentUser } from '@/lib/api-auth';
import { listCategories } from '@/lib/db/categories';
import { listPersonalRules } from '@/lib/db/personal-rules';
import { can } from '@/lib/rbac';
import { allTagsFromRules } from '@/lib/rules';
import { mayQueryDirectory, mayWriteQueries, queryScopeLimit } from '@/lib/written-query';

export default async function NewPersonalRulePage() {
  const user = await getCurrentUser();
  if (!user || !can(user.role, 'rules:personal')) notFound();

  const access = await resolveAccess(user);
  const mayWrite = mayWriteQueries(access);
  const directory = mayQueryDirectory(access);

  return (
    <>
      <Header
        title="New personal rule"
        description="Only you can see this rule and run it. Its results count nowhere else."
      />
      <main className="flex-1 p-6">
        {mayWrite.ok ? (
          <RuleNewClient
            personal
            allTags={allTagsFromRules(await listPersonalRules(user.id))}
            categories={await listCategories()}
            scopeLimit={queryScopeLimit(access) ?? undefined}
            directoryUnavailable={directory.ok ? undefined : directory.error}
          />
        ) : (
          <Callout tone="warn">{mayWrite.error}</Callout>
        )}
      </main>
    </>
  );
}
