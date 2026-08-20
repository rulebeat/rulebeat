import type { TenantContext } from '@rulebeat/core';
import { createTenantContext } from './azure-credential';
import { listCategories } from './db/categories';
import { startRun, finishRun, recordCategoryProgress, getRun, type RunTriggeredBy, type ScheduleRun } from './schedule-runs';
import { runCategoryScan } from './scan-runner';
import { resolveCategoriesForSchedule, resolveRulesForSchedule } from './schedule-target';
import type { ScheduleTargetType } from './db/schedules';
import { dispatchAndMarkSent } from './notifications/dispatch';

export interface RunTarget {
  targetType: ScheduleTargetType;
  targetValues: string[];
}

function groupRuleIdsByCategory(rules: { id: string; category: string }[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const r of rules) {
    const list = map.get(r.category);
    if (list) list.push(r.id); else map.set(r.category, [r.id]);
  }
  return map;
}

/** The shared execution core for both scheduled and manual ("Run Scan") runs. Resolves the
 *  target into concrete categories + (for tag/rule targeting) scoped rule ids, runs each touched
 *  category via runCategoryScan, and records the whole execution as one schedule_runs row —
 *  the single source of truth Run History reads from, regardless of what triggered it. */
export async function executeTarget(
  target: RunTarget,
  opts: {
    triggeredBy: RunTriggeredBy;
    scheduleId?: string;
    /** Injected by the demo generator to replay scans against a synthetic estate instead of a real
     *  Azure tenant — see lib/demo.ts. Falls back to createTenantContext() for every real run. */
    ctx?: TenantContext;
    /** Injected by the demo generator so a replayed run is stamped at its simulated date instead
     *  of the real current time — threaded through to startRun/finishRun and runCategoryScan. */
    now?: Date;
  },
): Promise<ScheduleRun> {
  const categoryIds = resolveCategoriesForSchedule(target);
  const scopedRuleIdsByCategory = (target.targetType === 'tags' || target.targetType === 'rules')
    ? groupRuleIdsByCategory(resolveRulesForSchedule(target))
    : null;

  const run = startRun({
    scheduleId: opts.scheduleId ?? '',
    triggeredBy: opts.triggeredBy,
    categories: categoryIds,
    targetType: target.targetType,
    targetValues: target.targetValues,
    now: opts.now,
  });
  const started = opts.now?.getTime() ?? Date.now();

  try {
    const ctx = opts.ctx ?? await createTenantContext({ runId: run.id });
    let totalFindings = 0;
    let newFindings = 0;
    const newFingerprints: string[] = [];
    const allNewFindings: import('./types').Finding[] = [];
    const errors: string[] = [];
    // A category can come back with coverage: 'partial' — one or more rules failed or returned a
    // capped/truncated result — without throwing at all, since runCategoryScan() completes
    // normally in that case. That must still surface as a partial run, not a silent 'success'.
    const partialCategories: string[] = [];

    const categoriesById = new Map(listCategories().map(c => [c.id, c]));
    for (const categoryId of categoryIds) {
      const category = categoriesById.get(categoryId);
      if (!category) continue;
      try {
        const ruleIds = scopedRuleIdsByCategory?.get(categoryId);
        const outcome = await runCategoryScan(category, {
          triggeredBy: opts.triggeredBy, scheduleId: opts.scheduleId, runId: run.id, ctx, ruleIds,
          now: opts.now,
        });
        totalFindings += outcome.summary.findings.length;
        newFindings += outcome.newFindings.length;
        const categoryFingerprints = outcome.newFindings.map(f => f.fingerprint);
        newFingerprints.push(...categoryFingerprints);
        allNewFindings.push(...outcome.newFindings);
        if (outcome.summary.coverage === 'partial') partialCategories.push(categoryId);
        // Durable the moment this category's findings are durable (scan-runner.ts's
        // syncScanFindings already wrote them) — not just once at the very end in finishRun(). A
        // crash before the next category starts would otherwise leave these findings with no
        // fingerprint ever recorded against the run, so recovery would have nothing to notify
        // from (spec 025).
        recordCategoryProgress(run.id, {
          totalFindings: outcome.summary.findings.length,
          newFindings: outcome.newFindings.length,
          newFindingFingerprints: categoryFingerprints,
        });
      } catch (err) {
        // Never put String(err) in a message that reaches the browser — an Azure SDK error carries
        // the full request URL (tenant and subscription ids). Run History renders run.error directly.
        console.error(`[RuleBeat] scan run ${run.id} — category ${categoryId} failed:`, err);
        errors.push(`${categoryId}: scan failed — check the RuleBeat server logs for details`);
      }
    }

    const allErrored = categoryIds.length > 0 && errors.length === categoryIds.length;
    const status = allErrored ? 'error' : (errors.length > 0 || partialCategories.length > 0) ? 'partial' : 'success';
    const messages = [...errors];
    if (partialCategories.length > 0) {
      messages.push(`${partialCategories.join(', ')}: one or more rules did not complete — see the category's scan for details`);
    }
    const willNotify = opts.triggeredBy === 'schedule' && allNewFindings.length > 0;
    finishRun(run.id, {
      status,
      totalFindings,
      newFindings,
      newFindingFingerprints: newFingerprints,
      error: messages.length > 0 ? messages.join('; ') : undefined,
      durationMs: (opts.now?.getTime() ?? Date.now()) - started,
      notifyStatus: willNotify ? 'pending' : 'none',
      now: opts.now,
    });

    if (willNotify) {
      void dispatchAndMarkSent(getRun(run.id)!, allNewFindings).catch(() => {});
    }
  } catch (err) {
    console.error(`[RuleBeat] scan run ${run.id} failed:`, err);
    finishRun(run.id, {
      status: 'error',
      totalFindings: 0,
      newFindings: 0,
      newFindingFingerprints: [],
      error: 'Scan run failed — check the RuleBeat server logs for details',
      durationMs: (opts.now?.getTime() ?? Date.now()) - started,
      now: opts.now,
    });
  }

  return getRun(run.id)!;
}
