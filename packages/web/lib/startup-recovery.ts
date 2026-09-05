import { listStaleRunningRuns, listNotificationRunsToRecover, finishRun, staleBefore } from './schedule-runs';
import { getFindingsByFingerprints } from './db/findings';
import { dispatchAndMarkSent } from './notifications/dispatch';

const RECOVERY_ERROR_MESSAGE =
  'Run did not complete. The server restarted or crashed while this scan was in progress.';

/**
 * Pass 1 of spec 025's two-pass recovery, run at startup and again on every scheduler tick. A row
 * still `status: 'running'` is an orphan only when the process that owns it has stopped proving it
 * is alive: its heartbeat (refreshed every 30 seconds by run-executor.ts) is older than
 * STALE_AFTER_MS, or missing altogether on a row from before the column existed. RuleBeat still
 * supports one replica, but a rolling deploy on Container Apps, Kubernetes or Compose keeps the old
 * and new container alive side by side for up to a minute (issue #88), and the new one's startup
 * used to mark the old one's live scan as crashed and notify about a run that then completed
 * normally. A fresh heartbeat now means "someone else's, and still going": left alone.
 *
 * Whatever findings that run had already durably recorded (via `recordCategoryProgress()`,
 * category by category, before the crash) are preserved rather than discarded — and if the run was
 * schedule-triggered and has any, `notifyStatus` is set to `'pending'` in the same write, handing
 * those findings to pass 2 exactly as if a live run had crashed between finishing and dispatching.
 */
export async function recoverInterruptedRuns(now: Date = new Date()): Promise<number> {
  const stale = await listStaleRunningRuns(staleBefore(now));

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
    console.log(`[recovery] marked ${stale.length} interrupted run(s) as not completed`);
  }
  return stale.length;
}

/**
 * Pass 2 of spec 025's recovery, also run at startup and on every tick. A row lands at
 * `notifyStatus: 'pending'` from either a live run that crashed between finishing and dispatching,
 * or from pass 1 recovering a stale `'running'` row above — this pass doesn't need to know which,
 * since both leave the same durable shape: a run row with fingerprints and no confirmed dispatch.
 * A `'sending'` row whose claim is older than STALE_AFTER_MS is the third shape, a process that
 * died mid-dispatch, and is taken over the same way; a fresh `'sending'` claim belongs to a live
 * process and is left alone (issue #88).
 *
 * Every row goes through `dispatchAndMarkSent()`, which claims it first, so two processes running
 * this pass at once over the same rows send each batch once: only the claim winner counts here.
 *
 * Fingerprints are resolved back to finding rows regardless of current status (active or fixed) —
 * a since-fixed finding was still real and new when the run detected it. A fingerprint whose rule
 * was since hard-deleted resolves to nothing; `dispatchAndMarkSent()` still marks the run `'sent'`
 * rather than dispatching an empty batch, so a startup with nothing left to notify about doesn't
 * loop on the same row forever.
 */
export async function recoverPendingNotifications(now: Date = new Date()): Promise<number> {
  const due = await listNotificationRunsToRecover(staleBefore(now));

  let recovered = 0;
  for (const run of due) {
    const findings = run.newFindingFingerprints.length > 0
      ? await getFindingsByFingerprints(run.newFindingFingerprints)
      : [];
    if (await dispatchAndMarkSent(run, findings, { now })) recovered++;
  }

  if (recovered > 0) {
    console.log(`[recovery] dispatched ${recovered} pending notification batch(es)`);
  }
  return recovered;
}
