import { notFound } from 'next/navigation';
import { Header } from '@/components/layout/header';
import { RuleNewClient } from '@/components/rules/rule-new-client';
import { loadRules, allTagsFromRules } from '@/lib/rules';
import { listCategories } from '@/lib/db/categories';
import { getCurrentUser } from '@/lib/api-auth';
import { can } from '@/lib/rbac';
import { canDuplicateRule } from '@/lib/rule-taxonomy';
import type { Rule } from '@/lib/types';

export default async function NewRulePage({
  searchParams,
}: {
  searchParams: Promise<{ copyFrom?: string }>;
}) {
  const { copyFrom } = await searchParams;
  // Without this a viewer could reach the form directly and only discover it's off-limits when
  // saving fails with a 403.
  const user = await getCurrentUser();
  if (!can(user?.role ?? 'viewer', 'rules:write')) notFound();

  const allRules = await loadRules();
  const allTags = allTagsFromRules(allRules);
  const categories = await listCategories();

  let prefilled: Rule | undefined;
  if (copyFrom) {
    const source = allRules.find(r => r.id === decodeURIComponent(copyFrom));
    if (source && canDuplicateRule(source)) {
      prefilled = {
        ...source,
        id: '',          // no id → RuleForm treats this as a new rule (POST)
        name: `${source.name} (copy)`,
        type: 'custom',
        pack: undefined,
        enabled: false,
      };
    }
  }

  return (
    <>
      <Header
        title={prefilled ? 'Duplicate Rule' : 'New Rule'}
        description={prefilled ? `Copy of "${prefilled.name.replace(' (copy)', '')}"` : 'Define a new governance rule for your tenant'}
      />
      <main className="flex-1 p-6">
        <RuleNewClient initial={prefilled} allTags={allTags} categories={categories} />
      </main>
    </>
  );
}
