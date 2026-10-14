import { notFound } from 'next/navigation';
import { Header } from '@/components/layout/header';
import { resolveAccess } from '@/lib/access';
import { getCurrentUser } from '@/lib/api-auth';
import { listCategories } from '@/lib/db/categories';
import { getPersonalRule, listPersonalRuleResults, listPersonalRules } from '@/lib/db/personal-rules';
import { viewCoveredScope, parseCoveredScope } from '@/lib/covered-scope-view';
import { planPersonalRun } from '@/lib/personal-rule-run';
import { can } from '@/lib/rbac';
import { splitLearnMore } from '@/lib/rule-description';
import { allTagsFromRules } from '@/lib/rules';
import { queryScopeLimit } from '@/lib/written-query';
import { PersonalRuleClient } from './personal-rule-client';

const VIEWER_RUN_MESSAGE = 'Your role is Viewer now, so you can read this rule and its last results but not run or change it.';

export default async function PersonalRulePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) notFound();

  // Someone else's rule reads exactly like a missing one, an Admin's view included.
  const rule = await getPersonalRule(decodeURIComponent(id), user.id);
  if (!rule) notFound();

  const access = await resolveAccess(user);
  const canWrite = can(user.role, 'rules:personal');
  const plan = planPersonalRun(rule, access);
  const runBlockedReason = !canWrite ? VIEWER_RUN_MESSAGE : plan.ok ? null : plan.error;

  const results = await listPersonalRuleResults(rule.id, user.id);
  const covered = rule.lastRunAt ? viewCoveredScope(parseCoveredScope(rule.lastRunCoveredScope), access) : null;
  const { lastRunCoveredScope: _stored, ...shown } = rule;

  return (
    <>
      <Header title={rule.name} description={splitLearnMore(rule.description).text || undefined} />
      <PersonalRuleClient
        rule={shown}
        updatedAt={rule.updatedAt}
        results={results}
        lastRunCovered={covered}
        allTags={allTagsFromRules(await listPersonalRules(user.id))}
        categories={await listCategories()}
        canWrite={canWrite}
        runBlockedReason={runBlockedReason}
        scopeLimit={queryScopeLimit(access) ?? undefined}
      />
    </>
  );
}
