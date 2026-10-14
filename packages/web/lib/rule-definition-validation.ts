import { hasCompilableFilter } from '@rulebeat/core/kql';
import type { Rule, QueryBackend, TenantContext } from '@rulebeat/core';
import { ADVISORY_ON_LOGS_ERROR, APPLIES_TO_REMOVED_ERROR, validateRuleName } from '@/lib/rules';
import { probeRuleIdentitySample } from '@/lib/rule-identity-check';
import { validateGraphQueryShape, probeGraphQuerySample } from '@/lib/graph-rule-validation';
import { validateLogAnalyticsQueryShape, probeLogAnalyticsQuerySample } from '@/lib/log-analytics-rule-validation';

/** A definition the server refuses, with the client-safe message to answer it with (always a 400). */
export type DefinitionCheck = { ok: true } | { ok: false; error: string };

export const NO_COMPILABLE_FILTER_ERROR =
  'The rule has no condition that compiles to a filter. It would match every resource in scope. Add at least one real condition.';

export interface DefinitionValidationOptions {
  /**
   * The context every probe queries through. A function, so nothing connects to Azure until a probe
   * needs it, and so a caller can hand the probes a context limited to what the author may reach.
   * A probe that cannot connect fails open: a transient Azure blip never newly blocks a save.
   */
  createContext: () => Promise<TenantContext>;
  /**
   * The backends the caller may author. Present on create, where the backend is chosen; left out on an
   * edit, where it is the stored rule's and cannot change.
   */
  allowedBackends?: readonly QueryBackend[];
}

/**
 * The checks a rule definition has to pass before it is stored, shared by `POST /api/rules`, `PUT
 * /api/rules/[id]` and the Personal rule routes so the three cannot drift: no `appliesTo`, a name, an
 * authorable backend, no Advisory on Logs, a condition that compiles to a filter, a sound Graph or Logs
 * query shape, and a rawKql that projects an identity. Returns the first failure.
 */
export async function validateRuleDefinition(
  body: Partial<Rule>,
  queryBackend: QueryBackend,
  options: DefinitionValidationOptions,
): Promise<DefinitionCheck> {
  if ('appliesTo' in body) return { ok: false, error: APPLIES_TO_REMOVED_ERROR };

  const nameError = validateRuleName(body.name);
  if (nameError) return { ok: false, error: nameError };

  if (options.allowedBackends) {
    if (!options.allowedBackends.includes(queryBackend)) {
      return { ok: false, error: `"${queryBackend}" rules cannot be authored yet.` };
    }
    if (body.kind === 'advisory' && queryBackend === 'log-analytics') {
      return { ok: false, error: ADVISORY_ON_LOGS_ERROR };
    }
  }

  // RB-RM-004: the UI guard (rule-form.tsx's save()) is client-side only. An API caller submitting
  // the same visualQuery shape the form does must be held to the same "at least one condition
  // actually compiles" bar, or a filterless query (matches every resource in scope) saves directly.
  if (body.visualQuery && !hasCompilableFilter(body.visualQuery)) {
    return { ok: false, error: NO_COMPILABLE_FILTER_ERROR };
  }

  if (queryBackend === 'microsoft-graph') {
    if (!body.graphQuery) return { ok: false, error: 'A Directory rule needs a Microsoft Graph query.' };
    const shapeError = validateGraphQueryShape(body.graphQuery);
    if (shapeError) return { ok: false, error: shapeError };
    try {
      await probeGraphQuerySample(body.graphQuery, await options.createContext());
    } catch (err) {
      // No Azure credential configured yet, or connecting failed outright: fail open, same as the
      // KQL identity probe below (see probeGraphQuerySample).
      console.error('[RuleBeat] rule-save Graph probe could not connect to Azure, allowing save:', err);
    }
  }

  if (queryBackend === 'log-analytics') {
    if (!body.logsQuery) return { ok: false, error: 'A Log Analytics rule needs a query.' };
    const shapeError = validateLogAnalyticsQueryShape(body.logsQuery);
    if (shapeError) return { ok: false, error: shapeError };
    try {
      await probeLogAnalyticsQuerySample(body.logsQuery, await options.createContext());
    } catch (err) {
      // No Azure credential/workspace configured yet, or connecting failed outright: fail open,
      // same as the Graph probe above.
      console.error('[RuleBeat] rule-save Log Analytics probe could not connect to Azure, allowing save:', err);
    }
  }

  if (body.rawKql) {
    try {
      const probe = await probeRuleIdentitySample(body.rawKql, await options.createContext());
      if (probe.blocked) {
        return {
          ok: false,
          error: `${probe.invalidCount} of ${probe.sampleSize} sampled row(s) have no resource id. Project id explicitly in the query`,
        };
      }
    } catch (err) {
      // No Azure credential configured yet, or connecting failed outright: fail open, same as a
      // probe query error (see probeRuleIdentitySample).
      console.error('[RuleBeat] rule-save identity probe could not connect to Azure, allowing save:', err);
    }
  }

  return { ok: true };
}
