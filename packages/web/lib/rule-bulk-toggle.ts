import type { Rule } from '@/lib/types';
import { bulkRequestBody, type BulkAction } from '@/lib/rule-bulk-selection';

export type BulkToggleOutcome =
  | { ok: true; action: BulkAction; updatedIds: string[]; notFound: string[] }
  | { ok: false; error: string };

export function rulesPhrase(n: number): string {
  return `${n} rule${n === 1 ? '' : 's'}`;
}

/**
 * Sends the Rules tab's bulk action to `PATCH /api/rules/bulk`, with the same failure contract as
 * the single enable switch (`requestRuleToggle`): a non-2xx response, a thrown fetch, and a
 * redirect all come back as an error, the redirect being an expired session answered with /signin.
 * On success, every sent id the server did not report as `notFound` counts as updated.
 */
export async function requestBulkToggle(
  action: BulkAction,
  ids: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<BulkToggleOutcome> {
  const fallback = `Could not ${action} ${rulesPhrase(ids.length)}. The change was not saved.`;
  try {
    const res = await fetchImpl('/api/rules/bulk', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bulkRequestBody(action, ids)),
    });
    if (!res.ok || res.redirected) {
      const body = await res.json().catch(() => ({})) as { error?: unknown };
      const error = typeof body.error === 'string' && body.error.trim() !== '' ? body.error : fallback;
      return { ok: false, error };
    }
    const body = await res.json().catch(() => ({})) as { notFound?: unknown };
    const reported = new Set(Array.isArray(body.notFound) ? body.notFound : []);
    return {
      ok: true,
      action,
      updatedIds: ids.filter(id => !reported.has(id)),
      notFound: ids.filter(id => reported.has(id)),
    };
  } catch {
    return { ok: false, error: fallback };
  }
}

/** Applied to the current list, like `applyRuleToggle`. Only the ids the server updated change;
 *  a failed request returns the list untouched. */
export function applyBulkToggle(rules: Rule[], outcome: BulkToggleOutcome): Rule[] {
  if (!outcome.ok) return rules;
  const updated = new Set(outcome.updatedIds);
  const enabled = outcome.action === 'enable';
  return rules.map(r => updated.has(r.id) && r.enabled !== enabled ? { ...r, enabled } : r);
}

/** "Disabled 18 rules." / "Enabled 1 rule.", with the ids that no longer exist named as skipped. */
export function bulkToggleMessage(outcome: Extract<BulkToggleOutcome, { ok: true }>): string {
  const verb = outcome.action === 'enable' ? 'Enabled' : 'Disabled';
  const text = `${verb} ${rulesPhrase(outcome.updatedIds.length)}.`;
  const skipped = outcome.notFound.length;
  if (skipped === 0) return text;
  return skipped === 1
    ? `${text} 1 no longer exists and was skipped.`
    : `${text} ${skipped} no longer exist and were skipped.`;
}
