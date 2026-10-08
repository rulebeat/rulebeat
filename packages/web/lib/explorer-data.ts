import { listFindings, type FindingRecord } from './db/findings';
import { loadRules } from './rules';
import { listCategories } from './db/categories';
import { RESULTS_KINDS, isOverdue, listsOnlyAdvisories } from './finding-kinds';
import { compareAdvisories } from './explorer-filters';
import type { RuleKind } from './types';

// ---- Types ----

/** 'new'/'active' is a client-side elapsed-time judgment (see getRecencyStatus in
 *  findings-explorer-client.tsx) — deliberately not computed here, since "new" only means
 *  something relative to a chosen time window, which is a UI setting, not stored data. */
export type FindingDisplayStatus = 'new' | 'active' | 'fixed';

export interface ExplorerFinding extends FindingRecord {
  policyName: string;
  ruleDisabled: boolean;
  ruleTags: string[];
  /** An open Advisory past its Deadline, as of the `now` the listing was built with. Display and
   *  ordering only; no count reads it. */
  overdue?: boolean;
}

export interface ExplorerData {
  findings: ExplorerFinding[];
  categories: Array<{ id: string; label: string; color?: string }>;
  policyOptions: Array<{ id: string; name: string; category: string }>;
  lastScanAt?: string;
}

// ---- Builder ----

/** `kinds` picks which findings the listing holds: the Results tab asks for Problems and Activity
 *  (the default), the Advisories tab for Advisory. It is a kind filter on the one findings table,
 *  not a second read model, so the next tab that needs a kind only passes its own. */
export async function buildExplorerData(
  opts: { kinds?: readonly RuleKind[]; now?: Date } = {},
): Promise<ExplorerData> {
  const now = opts.now ?? new Date();
  const rules = await loadRules();
  const policyMap = new Map(rules.map(r => [r.id, r]));
  const categories = await listCategories();

  const all = await listFindings({ kinds: opts.kinds ?? RESULTS_KINDS });

  const findings: ExplorerFinding[] = all.map(f => {
    const rule = policyMap.get(f.ruleId);
    return {
      ...f,
      policyName: rule?.name ?? f.title,
      ruleDisabled: rule ? !rule.enabled : false,
      ruleTags: rule?.tags ?? [],
      overdue: isOverdue(f, now),
    };
  });

  // The Advisories listing arrives in its own order, so a viewer who has not picked a sort sees
  // Overdue first. The stable sort leaves every other listing exactly as listFindings returned it.
  if (listsOnlyAdvisories(opts.kinds)) findings.sort(compareAdvisories);

  const policyOptions = [
    ...new Map(
      findings.map(f => [f.ruleId, { id: f.ruleId, name: f.policyName, category: f.category }]),
    ).values(),
  ].sort((a, b) => a.name.localeCompare(b.name));

  const lastScanAt = findings.reduce<string | undefined>((max, f) => {
    return !max || f.lastSeenAt > max ? f.lastSeenAt : max;
  }, undefined);

  return {
    findings,
    categories: categories.map(c => ({ id: c.id, label: c.label, color: c.color })),
    policyOptions,
    lastScanAt,
  };
}
