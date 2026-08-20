import { listFindings, type FindingRecord } from './db/findings';
import { loadRules } from './rules';
import { listCategories } from './db/categories';

// ---- Types ----

/** 'new'/'active' is a client-side elapsed-time judgment (see getRecencyStatus in
 *  findings-explorer-client.tsx) — deliberately not computed here, since "new" only means
 *  something relative to a chosen time window, which is a UI setting, not stored data. */
export type FindingDisplayStatus = 'new' | 'active' | 'fixed';

export interface ExplorerFinding extends FindingRecord {
  policyName: string;
  ruleDisabled: boolean;
  ruleTags: string[];
}

export interface ExplorerData {
  findings: ExplorerFinding[];
  categories: Array<{ id: string; label: string; color?: string }>;
  policyOptions: Array<{ id: string; name: string; category: string }>;
  lastScanAt?: string;
}

// ---- Builder ----

export function buildExplorerData(): ExplorerData {
  const rules = loadRules();
  const policyMap = new Map(rules.map(r => [r.id, r]));
  const categories = listCategories();

  const all = listFindings();

  const findings: ExplorerFinding[] = all.map(f => {
    const rule = policyMap.get(f.ruleId);
    return {
      ...f,
      policyName: rule?.name ?? f.title,
      ruleDisabled: rule ? !rule.enabled : false,
      ruleTags: rule?.tags ?? [],
    };
  });

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
