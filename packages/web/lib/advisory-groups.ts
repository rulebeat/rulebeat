import { compareAdvisories } from './explorer-filters';
import type { Severity } from './types';

/**
 * Grouping for the Advisories tab. Pure and client-safe: it only arranges findings the read model
 * already returned, so it never changes a count, never decides what is open, and never touches a
 * fingerprint. Fixing one resource resolves only its own Advisory (the lifecycle is per
 * fingerprint, in the scan sync); a group just shows that one member as Fixed while the rest stay open.
 */

/** What grouping needs of a finding: an ExplorerFinding satisfies it. */
export interface GroupableAdvisory {
  ruleId: string;
  policyName: string;
  recommendation: string;
  groupValue?: string;
  severity: Severity;
  status: 'active' | 'fixed';
  deadline?: string;
  overdue?: boolean;
  resourceName?: string;
  resourceId?: string;
}

/** One group value within a rule: the rule's recommendation text once, and the affected resources. */
export interface AdvisoryGroup<T extends GroupableAdvisory> {
  /** Stable key within the tab: the rule id and the group value. */
  key: string;
  /** Absent for findings with no group value, and for every finding of a rule with no group column. */
  groupValue?: string;
  recommendation: string;
  /** Most urgent first. */
  findings: T[];
  openCount: number;
  overdueCount: number;
}

export interface AdvisoryRuleGroup<T extends GroupableAdvisory> {
  ruleId: string;
  ruleName: string;
  /** Whether any of the rule's findings carries a group value. A rule with none is shown as one
   *  group with no heading of its own. */
  hasNamedGroups: boolean;
  groups: AdvisoryGroup<T>[];
  openCount: number;
  overdueCount: number;
}

const subject = (f: GroupableAdvisory) => f.resourceName || f.resourceId || '';

/** Open Advisories decide how urgent a group is; a group with none open is ranked by what it has. */
function mostUrgent<T extends GroupableAdvisory>(sortedFindings: T[]): T {
  return sortedFindings.find(f => f.status === 'active') ?? sortedFindings[0]!;
}

function compareMembers(a: GroupableAdvisory, b: GroupableAdvisory): number {
  return compareAdvisories(a, b) || subject(a).localeCompare(subject(b));
}

/**
 * Groups findings by rule, then by group value. Within a group the findings run most urgent first
 * (Overdue, then the earliest Deadline, then severity). Groups are ordered by their most urgent open
 * member, and rules by their most urgent group, so what needs action first is at the top. A group or
 * rule with nothing open sorts after every one with something open. Ties fall
 * back to names, with the group that has no value last.
 */
export function groupAdvisories<T extends GroupableAdvisory>(findings: readonly T[]): AdvisoryRuleGroup<T>[] {
  const byRule = new Map<string, T[]>();
  for (const f of findings) {
    const list = byRule.get(f.ruleId);
    if (list) list.push(f); else byRule.set(f.ruleId, [f]);
  }

  const rules = [...byRule.entries()].map(([ruleId, members]) => {
    const byValue = new Map<string, T[]>();
    for (const f of members) {
      const value = f.groupValue ?? '';
      const list = byValue.get(value);
      if (list) list.push(f); else byValue.set(value, [f]);
    }

    const groups = [...byValue.entries()].map(([value, list]) => {
      const sortedList = [...list].sort(compareMembers);
      const group: AdvisoryGroup<T> = {
        key: `${ruleId}::${value}`,
        ...(value === '' ? {} : { groupValue: value }),
        recommendation: mostUrgent(sortedList).recommendation,
        findings: sortedList,
        openCount: sortedList.filter(f => f.status === 'active').length,
        overdueCount: sortedList.filter(f => f.overdue).length,
      };
      return { group, lead: mostUrgent(sortedList) };
    }).sort((a, b) => (b.group.openCount > 0 ? 1 : 0) - (a.group.openCount > 0 ? 1 : 0)
      || compareAdvisories(a.lead, b.lead)
      || (a.group.groupValue === undefined ? 1 : b.group.groupValue === undefined ? -1 : a.group.groupValue.localeCompare(b.group.groupValue)));

    const ruleGroup: AdvisoryRuleGroup<T> = {
      ruleId,
      ruleName: members[0]!.policyName,
      hasNamedGroups: groups.some(g => g.group.groupValue !== undefined),
      groups: groups.map(g => g.group),
      openCount: groups.reduce((n, g) => n + g.group.openCount, 0),
      overdueCount: groups.reduce((n, g) => n + g.group.overdueCount, 0),
    };
    return { ruleGroup, lead: groups[0]!.lead };
  });

  return rules
    .sort((a, b) => (b.ruleGroup.openCount > 0 ? 1 : 0) - (a.ruleGroup.openCount > 0 ? 1 : 0)
      || compareAdvisories(a.lead, b.lead) || a.ruleGroup.ruleName.localeCompare(b.ruleGroup.ruleName))
    .map(r => r.ruleGroup);
}

/** The Advisories tab opens grouped; the flat table is the alternative. */
export type AdvisoryView = 'grouped' | 'list';

/** The URL param the Advisories tab keeps its view in. */
export const ADVISORY_VIEW_PARAM = 'view';

/** A `?view=` value read back from the URL: anything but an explicit `list` is the grouped view. */
export function parseAdvisoryView(value: string | undefined): AdvisoryView {
  return value === 'list' ? 'list' : 'grouped';
}

/** What to write to `?view=` for a view: nothing for the default, so a plain `/scans?tab=advisories`
 *  link and the grouped view are the same URL. The inverse of parseAdvisoryView(). */
export function advisoryViewParam(view: AdvisoryView): string | undefined {
  return view === 'grouped' ? undefined : view;
}
