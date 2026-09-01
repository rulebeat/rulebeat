import type { Finding } from '@/lib/types';
import type { ScheduleRun } from '@/lib/schedule-runs';
import { recordChannelResult, type StoredNotificationChannel } from '@/lib/db/notification-channels';
import { getChannelsForSchedule } from '@/lib/db/schedule-notification-channels';
import { recordDelivery } from '@/lib/db/notification-deliveries';
import { SEVERITY_ORDER } from '@/lib/severity';
import { buildScansHref } from '@/lib/scans-link';
import { getPublicUrl } from '@/lib/sign-in-config';
import { assertSafeWebhookUrl, assertSafeEmailHost, SsrfGuardError } from '@/lib/ssrf-guard';
import { markNotifySent } from '@/lib/schedule-runs';
import { buildPayload } from './format';

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [2_000, 8_000]; // delay before attempt 2, then before attempt 3

export function buildAbsoluteHref(path: string): string {
  const base = getPublicUrl();
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
 * The destination is SSRF-guarded once, before the retry loop — a guard rejection is a permanent
 * failure like a 4xx, not a transient one, so it is never retried (spec 021).
 */
async function sendWebhook(channel: StoredNotificationChannel, body: unknown): Promise<SendResult> {
  try {
    await assertSafeWebhookUrl(channel.url);
  } catch (err) {
    const message = err instanceof SsrfGuardError ? err.message : String(err).slice(0, 200);
    return { ok: false, attempts: 1, httpStatus: null, error: message };
  }

  let lastError: string | null = null;
  let lastStatus: number | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(channel.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
        redirect: 'manual',
      });
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        throw new SsrfGuardError(`Refusing to follow a redirect response from ${channel.url}.`);
      }

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
      lastError = String(err).slice(0, 200);
      // A redirect refusal is a property of the endpoint, not a transient hiccup — retrying would
      // just hit the same redirect again, so it fails like the pre-loop SSRF guard does (spec 021).
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
    await assertSafeEmailHost(cfg);
  } catch (err) {
    const message = err instanceof SsrfGuardError ? err.message : String(err).slice(0, 200);
    return { ok: false, attempts: 1, httpStatus: null, error: message };
  }

  try {
    const { default: nodemailer } = await import('nodemailer');
    const transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.tls === 'tls',
      requireTLS: cfg.tls === 'starttls',
      auth: cfg.username ? { user: cfg.username, pass: channel.url } : undefined,
    });

    await transporter.sendMail({
      from: cfg.fromAddress,
      to: cfg.toAddresses,
      subject,
      text,
    });

    return { ok: true, attempts: 1, httpStatus: null, error: null };
  } catch (err) {
    return { ok: false, attempts: 1, httpStatus: null, error: String(err).slice(0, 200) };
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
  const channels = getChannelsForSchedule(run.scheduleId);
  if (channels.length === 0) return;

  const scansPath = buildScansHref(
    { categories: [], severities: [], subscriptions: [], resourceGroups: [], tags: [], ruleIds: [], dateWindow: { mode: 'relative', days: 7 } },
    { status: 'new' },
  );
  const href = buildAbsoluteHref(scansPath);

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

/**
 * Dispatches (when there's anything to dispatch) then durably closes the run's notification outbox
 * entry. The single function both the live post-scan path and startup recovery call, so there is
 * exactly one place that decides "this run's notifications are done" (spec 025).
 *
 * `dispatchNotifications()` never throws under any current code path — every channel's send is
 * caught internally and the whole dispatch is `Promise.allSettled`-wrapped — so `notifyStatus` is
 * marked `'sent'` unconditionally once dispatch returns; per-channel success/failure is tracked
 * separately in notification_deliveries.
 */
export async function dispatchAndMarkSent(run: ScheduleRun, findings: Finding[]): Promise<void> {
  if (findings.length > 0) {
    await dispatchNotifications(run, findings);
  }
  markNotifySent(run.id);
}
