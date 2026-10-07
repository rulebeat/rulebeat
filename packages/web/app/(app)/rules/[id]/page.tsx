import { notFound } from 'next/navigation';
import { Header } from '@/components/layout/header';
import { loadRules, allTagsFromRules } from '@/lib/rules';
import { listCategories } from '@/lib/db/categories';
import { loadRecordedVersions } from '@/lib/db/recorded-versions';
import { describeOrigin } from '@/lib/rule-version-markers';
import { splitLearnMore } from '@/lib/rule-description';
import { getCurrentUser } from '@/lib/api-auth';
import { can } from '@/lib/rbac';
import { RuleDetailClient } from './rule-detail-client';

export default async function RuleDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ edit?: string }>;
}) {
  const { id } = await params;
  const { edit } = await searchParams;
  const decodedId = decodeURIComponent(id);
  const allRules = await loadRules();
  const rule = allRules.find(r => r.id === decodedId);
  if (!rule) notFound();

  const initialEditing = edit === 'true';
  const allTags = allTagsFromRules(allRules);
  const categories = await listCategories();
  const user = await getCurrentUser();

  // Only a custom rule with a recorded origin has one, so the table is read for no other rule.
  const origin = rule.type === 'custom' && rule.originRuleId
    ? describeOrigin(rule, allRules, await loadRecordedVersions())
    : null;

  const descriptionText = splitLearnMore(rule.description).text;

  return (
    <>
      <Header title={rule.name} description={descriptionText || undefined} />
      <RuleDetailClient
        rule={rule}
        origin={origin}
        kqlQuery={rule.rawKql}
        initialEditing={initialEditing}
        allTags={allTags}
        categories={categories}
        canAuthor={can(user?.role ?? 'viewer', 'rules:write')}
      />
    </>
  );
}
