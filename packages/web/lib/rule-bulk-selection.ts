import type { Rule } from '@/lib/types';

export type BulkAction = 'enable' | 'disable';
export type HeaderCheckboxState = 'all' | 'some' | 'none';

type SelectableRule = Pick<Rule, 'id' | 'enabled'>;

/** Drops every selected id that is not among the visible rules. Returns the same Set when nothing
 *  was dropped, so a state setter handed this result does not re-render for no change. */
export function pruneSelection(selected: Set<string>, visible: readonly Pick<Rule, 'id'>[]): Set<string> {
  const visibleIds = new Set(visible.map(r => r.id));
  const kept = [...selected].filter(id => visibleIds.has(id));
  return kept.length === selected.size ? selected : new Set(kept);
}

export function headerCheckboxState(selected: Set<string>, visible: readonly Pick<Rule, 'id'>[]): HeaderCheckboxState {
  const count = visible.filter(r => selected.has(r.id)).length;
  if (count === 0) return 'none';
  return count === visible.length ? 'all' : 'some';
}

/** The header checkbox: with every visible rule already selected it clears the selection,
 *  otherwise it selects exactly the visible rules, never one the filters hide. */
export function toggleAllVisible(selected: Set<string>, visible: readonly Pick<Rule, 'id'>[]): Set<string> {
  if (visible.length > 0 && headerCheckboxState(selected, visible) === 'all') return new Set();
  return new Set(visible.map(r => r.id));
}

/** Which selected rules each action would actually change: enabling touches only the disabled
 *  ones and disabling only the enabled ones. Only visible rules count, whatever `selected` holds. */
export function bulkChanges(selected: Set<string>, visible: readonly SelectableRule[]): Record<BulkAction, string[]> {
  const picked = visible.filter(r => selected.has(r.id));
  return {
    enable: picked.filter(r => !r.enabled).map(r => r.id),
    disable: picked.filter(r => r.enabled).map(r => r.id),
  };
}

/** The body for `PATCH /api/rules/bulk`, carrying only the ids whose state the action changes,
 *  so the audit row the server writes counts real changes. */
export function bulkRequestBody(action: BulkAction, ids: readonly string[]): { enable: string[] } | { disable: string[] } {
  return action === 'enable' ? { enable: [...ids] } : { disable: [...ids] };
}
