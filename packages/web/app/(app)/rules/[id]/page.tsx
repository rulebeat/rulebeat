import { notFound } from 'next/navigation';
import { Header } from '@/components/layout/header';
import { loadRules, allTagsFromRules, listRuleVersions } from '@/lib/rules';
import { listCategories } from '@/lib/db/categories';
import { loadRecordedVersions } from '@/lib/db/recorded-versions';
import { describeOrigin } from '@/lib/rule-version-markers';
import { splitLearnMore } from '@/lib/rule-description';
import { getPageAccess } from '@/lib/page-access';
import { can } from '@/lib/rbac';
import { personalCopyReasons } from '@/lib/personal-rule-request';
import { narrowRulesScope } from '@/lib/rule-scope-access';
import { writeControlsFor } from '@/lib/write-controls';
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
  const { user, access } = await getPageAccess();
  const allRules = narrowRulesScope(await loadRules(), access);
  const rule = allRules.find(r => r.id === decodedId);
  if (!rule) notFound();

  const initialEditing = edit === 'true';
  const allTags = allTagsFromRules(allRules);
  const categories = await listCategories();
  const controls = writeControlsFor(access);
  const versionHistory = rule.type === 'builtin' ? await listRuleVersions(rule.id) : null;

  // Only a custom rule with a recorded origin has one, so the table is read for no other rule.
  const origin = rule.type === 'custom' && rule.originRuleId
    ? describeOrigin(rule, allRules, await loadRecordedVersions())
    : null;

  const descriptionText = splitLearnMore(rule.description).text;

  return (
    <>
      <Header title={rule.name} description={descriptionText || undefined} />
      <RuleDetailClient
        key={`${rule.id}:${rule.version ?? ''}`}
        rule={rule}
        origin={origin}
        versionHistory={versionHistory ?? undefined}
        canVersion={can(user?.role ?? 'viewer', 'rules:version')}
        kqlQuery={rule.rawKql}
        initialEditing={initialEditing}
        allTags={allTags}
        categories={categories}
        canAuthor={controls.rulesWrite}
        writeReason={controls.reason}
        personalCopyReasons={personalCopyReasons(user?.role, access)}
      />
    </>
  );
}
