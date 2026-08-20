import type { Rule } from '@/lib/types';

// Shared by Library and Scans so pasting a name, tag, category, pack, type, severity, or the
// rule's own id/GUID into either page's search box finds the same rules the same way.
export function matchesRuleSearch(rule: Rule, query: string, categoryLabel?: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    rule.name,
    rule.description,
    rule.id,
    rule.category,
    categoryLabel,
    rule.pack,
    rule.type,
    rule.severity,
    ...(rule.tags ?? []),
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(q);
}
