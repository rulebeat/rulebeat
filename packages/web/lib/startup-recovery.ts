import { listRunningRuns, listPendingNotificationRuns, finishRun } from './schedule-runs';
import { getFindingsByFingerprints } from './db/findings';
import { dispatchAndMarkSent } from './notifications/dispatch';

const RECOVERY_ERROR_MESSAGE =
  'Run did not complete. The server restarted or crashed while this scan was in progress.';

/**
 * Pass 1 of spec 025's two-pass startup recovery. RuleBeat supports exactly one replica on one
 * local volume (P2-7) — at process start, this process has not yet begun a run, so any row still
 * `status: 'running'` can only be an orphan left by a previous process that crashed or was killed
 * mid-scan. There is no peer that could still legitimately hold the row, so no lease/heartbeat is
 * needed to tell orphan from live: every such row found here is one.
 *
 * Whatever findings that run had already durably recorded (via `recordCategoryProgress()`,
 * category by category, before the crash) are preserved rather than discarded — and if the run was
 * schedule-triggered and has any, `notifyStatus` is set to `'pending'` in the same write, handing
 * those findings to pass 2 exactly as if a live run had crashed between finishing and dispatching.
 */
export async function recoverInterruptedRuns(): Promise<number> {
  const stale = await listRunningRuns();

  for (const run of stale) {
    const willNotify = run.triggeredBy === 'schedule' && run.newFindingFingerprints.length > 0;
    await finishRun(run.id, {
      status: 'error',
      totalFindings: run.totalFindings,
      newFindings: run.newFindings,
      newFindingFingerprints: run.newFindingFingerprints,
      error: RECOVERY_ERROR_MESSAGE,
      durationMs: Date.now() - new Date(run.startedAt).getTime(),
      notifyStatus: willNotify ? 'pending' : 'none',
    });
  }

  if (stale.length > 0) {
    console.log(`[startup] recovered ${stale.length} interrupted run(s)`);
  }
  return stale.length;
}

/**
 * Pass 2 of spec 025's startup recovery. A row lands at `notifyStatus: 'pending'` from either a
 * live run that crashed between finishing and dispatching, or from pass 1 recovering a stale
 * `'running'` row above — this pass doesn't need to know which, since both leave the same durable
 * shape: a run row with fingerprints and no confirmed dispatch.
 *
 * Fingerprints are resolved back to finding rows regardless of current status (active or fixed) —
 * a since-fixed finding was still real and new when the run detected it. A fingerprint whose rule
 * was since hard-deleted resolves to nothing; `dispatchAndMarkSent()` still marks the run `'sent'`
 * rather than dispatching an empty batch, so a startup with nothing left to notify about doesn't
 * loop on the same row forever.
 */
export async function recoverPendingNotifications(): Promise<number> {
  const pending = await listPendingNotificationRuns();

  for (const run of pending) {
    const findings = run.newFindingFingerprints.length > 0
      ? await getFindingsByFingerprints(run.newFindingFingerprints)
      : [];
    await dispatchAndMarkSent(run, findings);
  }

  if (pending.length > 0) {
    console.log(`[startup] recovered ${pending.length} pending notification(s)`);
  }
  return pending.length;
}
