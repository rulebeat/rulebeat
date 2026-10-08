import type { Finding } from '@/lib/types';
import type { ScheduleRun } from '@/lib/schedule-runs';
import { recordChannelResult, type StoredNotificationChannel } from '@/lib/db/notification-channels';
import { getChannelsForSchedule } from '@/lib/db/schedule-notification-channels';
import { recordDelivery } from '@/lib/db/notification-deliveries';
import { SEVERITY_ORDER } from '@/lib/severity';
import { buildScansHref } from '@/lib/scans-link';
import { getPublicUrl } from '@/lib/sign-in-config';
import { RedirectRefusedError, SsrfGuardError } from '@/lib/ssrf-guard';
import { claimNotifyDispatch, markNotifySent } from '@/lib/schedule-runs';
import { loadSuppressions, isActiveSuppression } from '@/lib/suppressions';
import { isNotifiable } from '@/lib/finding-kinds';
import { isDemoMode } from '@/lib/demo';
import { buildPayload } from './format';
import { postWebhookJson, sendSmtpMail } from './send';

/** What a Demo records, and "Send test" answers, instead of sending. */
export const DEMO_NOT_SENT = 'Not sent: this is a Demo.';

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [2_000, 8_000]; // delay before attempt 2, then before attempt 3

export async function buildAbsoluteHref(path: string): Promise<string> {
  const base = await getPublicUrl();
  if (base) return base.replace(/\/$/, '') + path;
  return path;
}

function meetsThreshold(severity: string, minSeverity: string): boolean {
  const idx = SEVERITY_ORDER.indexOf(severity as (typeof SEVERITY_ORDER)[number]);
  const minIdx = SEVERITY_ORDER.indexOf(minSeverity as (typeof SEVERITY_ORDER)[number]);
  return idx !== -1 && minIdx !== -1 && idx <= minIdx;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface SendResult {
  ok: boolean;
  attempts: number;
  httpStatus: number | null;
  error: string | null;
}

/**
 * POSTs to a webhook channel with retry/backoff for transient failures. A 4xx response is never
 * retried. Network/timeout errors and 5xx/429 are retried up to MAX_ATTEMPTS total.
 *
 * Every attempt goes through the guarded send, which checks the destination at the moment it
 * connects. A guard rejection is a permanent failure like a 4xx, not a transient one, so it is
 * never retried (spec 021).
 */
async function sendWebhook(channel: StoredNotificationChannel, body: unknown): Promise<SendResult> {
  let lastError: string | null = null;
  let lastStatus: number | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await postWebhookJson(channel.url, body);

      if (res.ok) {
        return { ok: true, attempts: attempt, httpStatus: res.status, error: null };
      }

      const text = await res.text().catch(() => '');
      lastStatus = res.status;
      lastError = `HTTP ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`;

      const transient = res.status === 429 || res.status >= 500;
      if (!transient || attempt === MAX_ATTEMPTS) {
        return { ok: false, attempts: attempt, httpStatus: lastStatus, error: lastError };
      }
    } catch (err) {
      lastStatus = null;
      // A blocked address reads as its own message; a redirect refusal keeps its long-standing form.
      lastError = err instanceof SsrfGuardError && !(err instanceof RedirectRefusedError)
        ? err.message
        : String(err).slice(0, 200);
      // A refused address or redirect is a property of the endpoint, not a transient hiccup —
      // retrying would just hit the same answer again (spec 021).
      if (err instanceof SsrfGuardError || attempt === MAX_ATTEMPTS) {
        return { ok: false, attempts: attempt, httpStatus: null, error: lastError };
      }
    }

    await sleep(BACKOFF_MS[attempt - 1]);
  }

  return { ok: false, attempts: MAX_ATTEMPTS, httpStatus: lastStatus, error: lastError };
}

/** Sends a single email via SMTP using nodemailer. One attempt only — SMTP errors are final. */
async function sendEmail(channel: StoredNotificationChannel, subject: string, text: string): Promise<SendResult> {
  const cfg = channel.emailConfig;
  if (!cfg) {
    return { ok: false, attempts: 1, httpStatus: null, error: 'Email channel has no SMTP configuration.' };
  }

  try {
    await sendSmtpMail(cfg, channel.url, { subject, text });
    return { ok: true, attempts: 1, httpStatus: null, error: null };
  } catch (err) {
    const message = err instanceof SsrfGuardError ? err.message : String(err).slice(0, 200);
    return { ok: false, attempts: 1, httpStatus: null, error: message };
  }
}

/**
 * Sends outbound notifications for a completed scheduled scan.
 *
 * Best-effort: each channel is attempted independently. A failure on one channel never affects the
 * others, and no exception is ever propagated to the caller (the scan has already finished).
 *
 * C1b: each channel's findings are pre-filtered by its category/subscription scope before
 * applying the severity threshold, so a channel scoped to "Security" never fires for Cost findings.
 */
export async function dispatchNotifications(run: ScheduleRun, newFindings: Finding[]): Promise<void> {
  const channels = await getChannelsForSchedule(run.scheduleId);
  if (channels.length === 0) return;

  const scansPath = buildScansHref(
    { categories: [], severities: [], subscriptions: [], resourceGroups: [], tags: [], ruleIds: [], dateWindow: { mode: 'relative', days: 7 } },
    { status: 'new' },
  );
  const href = await buildAbsoluteHref(scansPath);
  const demo = await isDemoMode();

  await Promise.allSettled(
    channels.map(async channel => {
      // C1b: apply category/subscription scope before severity threshold
      const scoped = newFindings.filter(f => {
        if (channel.categoryIds && !channel.categoryIds.includes(f.category)) return false;
        if (channel.subscriptionIds && !channel.subscriptionIds.includes(f.subscriptionId)) return false;
        return true;
      });

      const filtered = scoped.filter(f => meetsThreshold(f.severity, channel.minSeverity));
      if (filtered.length === 0) return;

      // A Demo records what would have been sent, with zero attempts, and contacts nothing. The
      // channel's own last-result fields are left alone: nothing was tried, so nothing failed.
      if (demo) {
        await recordDelivery({
          channelId: channel.id,
          scheduleId: run.scheduleId,
          runId: run.id,
          ok: false,
          attempts: 0,
          httpStatus: null,
          error: DEMO_NOT_SENT,
          findingsCount: filtered.length,
        });
        return;
      }

      const payload = buildPayload(channel.type, filtered, href, run);

      let result: SendResult;
      if (payload.kind === 'email') {
        result = await sendEmail(channel, payload.subject, payload.text);
      } else {
        result = await sendWebhook(channel, payload.body);
      }

      await recordChannelResult(channel.id, { ok: result.ok, error: result.error ?? undefined });
      await recordDelivery({
        channelId: channel.id,
        scheduleId: run.scheduleId,
        runId: run.id,
        ok: result.ok,
        attempts: result.attempts,
        httpStatus: result.httpStatus,
        error: result.error,
        findingsCount: filtered.length,
      });
    }),
  );
}

/** Drops findings whose fingerprint has an active suppression, by the same predicate the Results
 *  tab and dashboards use (`isActiveSuppression`, so an expired suppression hides nothing). */
async function withoutSuppressed(findings: Finding[]): Promise<Finding[]> {
  if (findings.length === 0) return findings;
  const suppressed = new Set((await loadSuppressions()).filter(isActiveSuppression).map(s => s.fingerprint));
  return findings.filter(f => !suppressed.has(f.fingerprint));
}

/**
 * Claims the run's notification outbox entry, dispatches (when there's anything to dispatch), then
 * durably closes the entry. The single function both the live post-scan path and startup recovery
 * call, so there is exactly one place that decides "this run's notifications are done" (spec 025).
 *
 * The claim is what stops two processes sending the same batch (issue #88): the row goes
 * 'pending' -> 'sending' in one conditional UPDATE, so of the live post-scan dispatch and a
 * replacement container's recovery pass, whichever gets there second sees no row change and
 * returns `false` without sending. A 'sending' claim whose owner died is taken over only after
 * STALE_AFTER_MS (schedule-runs.ts).
 *
 * `dispatchNotifications()` never throws under any current code path — every channel's send is
 * caught internally and the whole dispatch is `Promise.allSettled`-wrapped — so `notifyStatus` is
 * marked `'sent'` unconditionally once dispatch returns; per-channel success/failure is tracked
 * separately in notification_deliveries.
 *
 * Findings suppressed at this moment are left out (issue #144): a suppressed finding whose
 * resource was fixed and broke again reactivates under the same fingerprint and counts as new in
 * the scan, but its suppression still applies. Checked here, after the claim, so the live path and
 * recovery share one decision and a suppression added or expired since the scan is honoured. A
 * batch that is all suppressed is treated like an empty one: nothing is sent and the entry closes.
 *
 * Advisory findings are left out the same way (issue #176): a channel cannot opt in to receiving
 * them yet, so only the kinds in NOTIFIABLE_KINDS are announced.
 *
 * @returns whether this call held the claim and therefore did the dispatching.
 */
export async function dispatchAndMarkSent(
  run: ScheduleRun,
  findings: Finding[],
  opts: { now?: Date } = {},
): Promise<boolean> {
  if (!(await claimNotifyDispatch(run.id, { now: opts.now }))) return false;
  const notifiable = (await withoutSuppressed(findings)).filter(isNotifiable);
  if (notifiable.length > 0) {
    await dispatchNotifications(run, notifiable);
  }
  await markNotifySent(run.id);
  return true;
}
