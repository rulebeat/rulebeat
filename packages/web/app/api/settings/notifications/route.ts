import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import {
  listChannels,
  createChannel,
  updateChannel,
  deleteChannel,
  getChannelSummary,
  type NotificationChannelType,
  type EmailChannelConfig,
} from '@/lib/db/notification-channels';
import { assertSafeWebhookUrl, assertSafeEmailHost, SsrfGuardError } from '@/lib/ssrf-guard';

const CHANNEL_TYPES = new Set<NotificationChannelType>(['teams', 'slack', 'webhook', 'email']);

function validateEmailConfig(config: unknown): config is EmailChannelConfig {
  if (!config || typeof config !== 'object') return false;
  const c = config as Record<string, unknown>;
  return (
    typeof c.host === 'string' && c.host.trim() !== '' &&
    typeof c.port === 'number' && c.port > 0 &&
    ['none', 'starttls', 'tls'].includes(c.tls as string) &&
    typeof c.username === 'string' &&
    typeof c.fromAddress === 'string' && c.fromAddress.trim() !== '' &&
    typeof c.toAddresses === 'string' && c.toAddresses.trim() !== ''
  );
}

export async function GET() {
  const actor = await requireRole('notifications:manage');
  if (actor instanceof NextResponse) return actor;

  return NextResponse.json(await listChannels());
}

export async function POST(req: Request) {
  const actor = await requireRole('notifications:manage');
  if (actor instanceof NextResponse) return actor;

  let body: { name?: string; type?: string; url?: string; config?: unknown };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }

  const name = body.name?.trim() ?? '';
  const type = body.type?.trim() ?? '';
  const url = body.url?.trim() ?? '';

  if (!name) return NextResponse.json({ error: 'Name is required.' }, { status: 400 });
  if (!CHANNEL_TYPES.has(type as NotificationChannelType)) {
    return NextResponse.json({ error: 'Type must be one of: teams, slack, webhook, email.' }, { status: 400 });
  }

  if (type === 'email') {
    if (!validateEmailConfig(body.config)) {
      return NextResponse.json({ error: 'Email channels require a valid config (host, port, tls, fromAddress, toAddresses).' }, { status: 400 });
    }
    try {
      await assertSafeEmailHost(body.config);
    } catch (err) {
      const message = err instanceof SsrfGuardError ? err.message : 'SMTP host is not allowed.';
      return NextResponse.json({ error: message }, { status: 400 });
    }
    try {
      const channel = await createChannel({ name, type: 'email', url, config: body.config as EmailChannelConfig });
      writeAudit({
        actor,
        action: 'notification_channel.create',
        entityType: 'notification_channel',
        entityId: channel.id,
        summary: `Created email notification channel "${name}"`,
        details: { fields: ['name', 'type', 'config'] },
      });
      return NextResponse.json(channel, { status: 201 });
    } catch (err) {
      return serverError('Failed to create the notification channel', err);
    }
  }

  if (!url) return NextResponse.json({ error: 'URL is required.' }, { status: 400 });
  try { new URL(url); } catch {
    return NextResponse.json({ error: 'URL must be a valid URL.' }, { status: 400 });
  }
  try {
    await assertSafeWebhookUrl(url);
  } catch (err) {
    const message = err instanceof SsrfGuardError ? err.message : 'URL is not allowed.';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const channel = await createChannel({ name, type: type as NotificationChannelType, url });
    writeAudit({
      actor,
      action: 'notification_channel.create',
      entityType: 'notification_channel',
      entityId: channel.id,
      summary: `Created notification channel "${name}" (${type})`,
      details: { fields: ['name', 'type'] },
    });
    return NextResponse.json(channel, { status: 201 });
  } catch (err) {
    return serverError('Failed to create the notification channel', err);
  }
}

export async function PUT(req: Request) {
  const actor = await requireRole('notifications:manage');
  if (actor instanceof NextResponse) return actor;

  let body: { id?: string; name?: string; type?: string; url?: string; config?: unknown };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }

  const id = body.id?.trim() ?? '';
  if (!id) return NextResponse.json({ error: 'id is required.' }, { status: 400 });

  const existing = await getChannelSummary(id);
  if (!existing) return NextResponse.json({ error: 'Channel not found.' }, { status: 404 });

  const effectiveType = (body.type?.trim() ?? existing.type) as NotificationChannelType;
  if (body.type !== undefined && !CHANNEL_TYPES.has(effectiveType)) {
    return NextResponse.json({ error: 'Type must be one of: teams, slack, webhook, email.' }, { status: 400 });
  }

  if (effectiveType !== 'email' && body.url !== undefined && body.url.trim()) {
    const trimmedUrl = body.url.trim();
    try { new URL(trimmedUrl); } catch {
      return NextResponse.json({ error: 'URL must be a valid URL.' }, { status: 400 });
    }
    try {
      await assertSafeWebhookUrl(trimmedUrl);
    } catch (err) {
      const message = err instanceof SsrfGuardError ? err.message : 'URL is not allowed.';
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }

  if (effectiveType === 'email' && body.config !== undefined) {
    if (!validateEmailConfig(body.config)) {
      return NextResponse.json({ error: 'Email config must include host, port, tls, fromAddress, and toAddresses.' }, { status: 400 });
    }
    try {
      await assertSafeEmailHost(body.config);
    } catch (err) {
      const message = err instanceof SsrfGuardError ? err.message : 'SMTP host is not allowed.';
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }

  try {
    const updated = await updateChannel(id, {
      name: body.name,
      type: body.type as NotificationChannelType | undefined,
      url: body.url,
      config: body.config !== undefined ? (body.config as EmailChannelConfig | undefined) : undefined,
    });
    if (!updated) return NextResponse.json({ error: 'Channel not found.' }, { status: 404 });

    writeAudit({
      actor,
      action: 'notification_channel.update',
      entityType: 'notification_channel',
      entityId: id,
      summary: `Updated notification channel "${updated.name}"`,
      details: { fields: Object.keys(body).filter(k => k !== 'id') },
    });
    return NextResponse.json(updated);
  } catch (err) {
    return serverError('Failed to update the notification channel', err);
  }
}

export async function DELETE(req: Request) {
  const actor = await requireRole('notifications:manage');
  if (actor instanceof NextResponse) return actor;

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id')?.trim() ?? '';
  if (!id) return NextResponse.json({ error: 'id query parameter is required.' }, { status: 400 });

  const existing = await getChannelSummary(id);
  if (!existing) return NextResponse.json({ error: 'Channel not found.' }, { status: 404 });

  try {
    await deleteChannel(id);
    writeAudit({
      actor,
      action: 'notification_channel.delete',
      entityType: 'notification_channel',
      entityId: id,
      summary: `Deleted notification channel "${existing.name}"`,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return serverError('Failed to delete the notification channel', err);
  }
}
