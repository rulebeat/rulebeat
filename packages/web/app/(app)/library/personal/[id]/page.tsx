import { notFound } from 'next/navigation';
import { Header } from '@/components/layout/header';
import { resolveAccess } from '@/lib/access';
import { getCurrentUser } from '@/lib/api-auth';
import { listCategories } from '@/lib/db/categories';
import { listLibraryRequestsForPersonalRule } from '@/lib/db/library-requests';
import { getPersonalRule, listPersonalRuleResults, listPersonalRules } from '@/lib/db/personal-rules';
import { authorRequestView } from '@/lib/library-request-view';
import { viewCoveredScope, parseCoveredScope } from '@/lib/covered-scope-view';
import { planPersonalRun } from '@/lib/personal-rule-run';
import { can, mayAct } from '@/lib/rbac';
import { splitLearnMore } from '@/lib/rule-description';
import { allTagsFromRules, loadRule } from '@/lib/rules';
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
  const { lastRunCoveredScope: _stored, sourceRuleId, libraryRuleId, ...shown } = rule;
  // The link shows only while the shared rule still exists. Deleting it clears sourceRuleId already, so a
  // missing row here is a race that reads the same as no link.
  const source = sourceRuleId ? await loadRule(sourceRuleId) : null;

  // The Library requests of this rule, newest first, and the library rule a direct copy made (#282).
  const requests = await Promise.all((await listLibraryRequestsForPersonalRule(rule.id, user.id)).map(authorRequestView));
  const copied = libraryRuleId ? await loadRule(libraryRuleId) : null;
  const copiedTo = copied ? { id: copied.id, name: copied.name } : null;
  // Copy to library is for reviewers only. Off while the rule is already in the library, so a second click cannot add it twice.
  const inLibrary = copiedTo ?? requests.find(r => r.status === 'approved')?.libraryRule ?? null;
  const copyToLibrary = mayAct(access, 'rules:write')
    ? { reason: inLibrary ? `This rule is already in the library as "${inLibrary.name}".` : null }
    : null;

  return (
    <>
      <Header title={rule.name} description={splitLearnMore(rule.description).text || undefined} />
      <PersonalRuleClient
        rule={shown}
        source={source ? { id: source.id, name: source.name } : null}
        requests={requests}
        copiedTo={copiedTo}
        copyToLibrary={copyToLibrary}
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
