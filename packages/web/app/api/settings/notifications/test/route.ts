import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import { getStoredChannel, type NotificationChannelType, type EmailChannelConfig } from '@/lib/db/notification-channels';
import { buildPayload } from '@/lib/notifications/format';
import { buildAbsoluteHref } from '@/lib/notifications/dispatch';
import { guardedFetch, assertSafeEmailHost, SsrfGuardError } from '@/lib/ssrf-guard';
import type { Finding, Severity } from '@/lib/types';

/**
 * "Send test" — sends a sample message to a channel.
 *
 * Two modes:
 *  - body contains { id } → tests the saved channel
 *  - body contains { type, url, config? } → tests unsaved values typed into the form
 */

const SAMPLE_FINDINGS: Finding[] = [
  {
    module: 'test',
    ruleId: 'test-rule-id',
    fingerprint: 'test-fingerprint',
    severity: 'high' as Severity,
    category: 'security',
    resourceId: '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-example/providers/Microsoft.Compute/virtualMachines/vm-example',
    resourceType: 'microsoft.compute/virtualmachines',
    resourceName: 'vm-example',
    subscriptionId: '00000000-0000-0000-0000-000000000000',
    resourceGroup: 'rg-example',
    location: 'eastus',
    title: 'Test finding from RuleBeat',
    description: 'This is a test message to verify the notification channel is working.',
    recommendation: 'No action needed. This is a test.',
    remediationSteps: [],
    evidence: {},
    detectedAt: new Date().toISOString(),
  },
];

const SAMPLE_RUN = {
  id: 'test-run-id',
  scheduleId: 'test-schedule-id',
  triggeredBy: 'schedule' as const,
  targetType: 'all' as const,
  targetValues: [],
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  status: 'success' as const,
  categories: [],
  totalFindings: 1,
  newFindings: 1,
  newFindingFingerprints: ['test-fingerprint'],
  error: null,
  durationMs: 1000,
  notifyStatus: 'none' as const,
};

export async function POST(req: Request) {
  const actor = await requireRole('notifications:manage');
  if (actor instanceof NextResponse) return actor;

  let body: { id?: string; type?: string; url?: string; config?: EmailChannelConfig } = {};
  try {
    body = await req.json() as typeof body;
  } catch { /* empty body is fine */ }

  let type: NotificationChannelType;
  let url: string;
  let emailConfig: EmailChannelConfig | null = null;
  let channelId: string | undefined;

  if (body.id) {
    const channel = getStoredChannel(body.id);
    if (!channel) {
      return NextResponse.json({ error: 'Channel not found or secret is unreadable.' }, { status: 404 });
    }
    type = channel.type;
    url = channel.url;
    emailConfig = channel.emailConfig;
    channelId = channel.id;
  } else {
    const t = body.type?.trim();
    if (!t || !['teams', 'slack', 'webhook', 'email'].includes(t)) {
      return NextResponse.json({ error: 'type is required (teams, slack, webhook, or email).' }, { status: 400 });
    }
    type = t as NotificationChannelType;
    url = body.url?.trim() ?? '';

    if (type === 'email') {
      emailConfig = body.config ?? null;
      if (!emailConfig?.host || !emailConfig?.fromAddress || !emailConfig?.toAddresses) {
        return NextResponse.json({ error: 'Email test requires config.host, config.fromAddress, and config.toAddresses.' }, { status: 400 });
      }
    } else {
      if (!url) return NextResponse.json({ error: 'url is required.' }, { status: 400 });
      try { new URL(url); } catch {
        return NextResponse.json({ error: 'url must be a valid URL.' }, { status: 400 });
      }
    }
  }

  const href = buildAbsoluteHref('/scans?tab=results');
  const payload = buildPayload(type, SAMPLE_FINDINGS, href, SAMPLE_RUN);

  try {
    let ok: boolean;
    let errorMsg: string | undefined;

    if (payload.kind === 'email') {
      if (!emailConfig) {
        return NextResponse.json({ error: 'No SMTP configuration available for this channel.' }, { status: 400 });
      }
      try {
        await assertSafeEmailHost(emailConfig);
      } catch (err) {
        const message = err instanceof SsrfGuardError ? err.message : 'SMTP host is not allowed.';
        writeAudit({
          actor,
          action: 'notification_channel.test',
          entityType: 'notification_channel',
          entityId: channelId,
          summary: `Tested notification channel — failed: ${message.slice(0, 80)}`,
          details: { ok: false },
        });
        return NextResponse.json({ ok: false, error: message }, { status: 400 });
      }
      const { default: nodemailer } = await import('nodemailer');
      const transporter = nodemailer.createTransport({
        host: emailConfig.host,
        port: emailConfig.port,
        secure: emailConfig.tls === 'tls',
        requireTLS: emailConfig.tls === 'starttls',
        auth: emailConfig.username ? { user: emailConfig.username, pass: url } : undefined,
      });
      try {
        await transporter.sendMail({
          from: emailConfig.fromAddress,
          to: emailConfig.toAddresses,
          subject: payload.subject,
          text: payload.text,
        });
        ok = true;
      } catch (err) {
        ok = false;
        errorMsg = String(err).slice(0, 200);
      }
    } else {
      let res: Response;
      try {
        res = await guardedFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload.body),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        if (err instanceof SsrfGuardError) {
          writeAudit({
            actor,
            action: 'notification_channel.test',
            entityType: 'notification_channel',
            entityId: channelId,
            summary: `Tested notification channel — failed: ${err.message.slice(0, 80)}`,
            details: { ok: false },
          });
          return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
        }
        throw err;
      }
      ok = res.ok;
      if (!ok) {
        const text = await res.text().catch(() => '');
        errorMsg = `HTTP ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`;
      }
    }

    writeAudit({
      actor,
      action: 'notification_channel.test',
      entityType: 'notification_channel',
      entityId: channelId,
      summary: ok
        ? 'Tested notification channel — delivered successfully'
        : `Tested notification channel — failed${errorMsg ? ': ' + errorMsg.slice(0, 80) : ''}`,
      details: { ok },
    });

    if (ok) return NextResponse.json({ ok: true });
    return NextResponse.json({ ok: false, error: errorMsg ?? 'Delivery failed.' }, { status: 400 });
  } catch (err) {
    writeAudit({
      actor,
      action: 'notification_channel.test',
      entityType: 'notification_channel',
      entityId: channelId,
      summary: 'Tested notification channel — failed (network error)',
      details: { ok: false },
    });
    if (String(err).includes('TimeoutError') || String(err).includes('AbortError')) {
      return NextResponse.json({ ok: false, error: 'Request timed out after 10 seconds.' }, { status: 400 });
    }
    return serverError('Failed to deliver the test notification', err);
  }
}
