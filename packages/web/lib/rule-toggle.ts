import type { Rule } from '@/lib/types';

export type RuleToggleOutcome = { ok: true; rule: Rule } | { ok: false; error: string };

/**
 * Sends the Rules tab's enable switch as a full-rule PUT and reports whether the server accepted
 * it. Only an accepted change comes back as `ok: true`; a non-2xx response, a thrown fetch, and a
 * redirect all come back as an error. The redirect case is an expired session: the proxy answers
 * it with a redirect to /signin, and a followed redirect can end on a 2xx that saved nothing.
 */
export async function requestRuleToggle(rule: Rule, fetchImpl: typeof fetch = fetch): Promise<RuleToggleOutcome> {
  const updated = { ...rule, enabled: !rule.enabled };
  const fallback = `Could not ${updated.enabled ? 'enable' : 'disable'} "${rule.name}". The change was not saved.`;
  try {
    const res = await fetchImpl(`/api/rules/${encodeURIComponent(rule.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    });
    if (!res.ok || res.redirected) {
      const body = await res.json().catch(() => ({})) as { error?: unknown };
      const error = typeof body.error === 'string' && body.error.trim() !== '' ? body.error : fallback;
      return { ok: false, error };
    }
    return { ok: true, rule: updated };
  } catch {
    return { ok: false, error: fallback };
  }
}

/** Applied to the current list rather than the one the toggle started from, so two toggles in
 *  flight at once cannot overwrite each other. A failed toggle returns the list untouched. */
export function applyRuleToggle(rules: Rule[], outcome: RuleToggleOutcome): Rule[] {
  if (!outcome.ok) return rules;
  return rules.map(r => r.id === outcome.rule.id ? outcome.rule : r);
}
