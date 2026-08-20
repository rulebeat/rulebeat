'use client';

import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { FieldHint, Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import type { NotificationChannelSummary, NotificationChannelType, EmailChannelConfig } from '@/lib/db/notification-channels';
import type { NotificationDelivery } from '@/lib/db/notification-deliveries';
import {
  Bell, Check, ChevronDown, ChevronUp, Clock, Loader2, Plus, Send, Trash2, X,
} from 'lucide-react';

const CHANNEL_TYPE_LABELS: Record<NotificationChannelType, string> = {
  teams: 'Microsoft Teams',
  slack: 'Slack',
  webhook: 'Webhook',
  email: 'Email (SMTP)',
};

const WEBHOOK_HELP: Record<string, { label: string; href: string }> = {
  teams: { label: 'How to get a Teams Workflows URL', href: 'https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook' },
  slack: { label: 'How to get a Slack incoming webhook URL', href: 'https://api.slack.com/messaging/webhooks' },
  webhook: { label: 'Webhook payload documentation', href: '' },
};

const TLS_OPTIONS: { value: EmailChannelConfig['tls']; label: string }[] = [
  { value: 'starttls', label: 'STARTTLS (port 587)' },
  { value: 'tls', label: 'SSL/TLS (port 465)' },
  { value: 'none', label: 'None (port 25)' },
];

const CHANNEL_TYPE_OPTIONS = (Object.keys(CHANNEL_TYPE_LABELS) as NotificationChannelType[])
  .map(t => ({ value: t, label: CHANNEL_TYPE_LABELS[t] }));

interface EmailFormState {
  host: string;
  port: string;
  tls: EmailChannelConfig['tls'];
  username: string;
  fromAddress: string;
  toAddresses: string;
}

const DEFAULT_EMAIL: EmailFormState = {
  host: '',
  port: '587',
  tls: 'starttls',
  username: '',
  fromAddress: '',
  toAddresses: '',
};

interface FormState {
  name: string;
  type: NotificationChannelType;
  url: string;         // webhook URL or SMTP password
  email: EmailFormState;
}

const DEFAULT_FORM: FormState = {
  name: '',
  type: 'teams',
  url: '',
  email: DEFAULT_EMAIL,
};

function emailConfigFromForm(e: EmailFormState): EmailChannelConfig {
  return {
    host: e.host.trim(),
    port: parseInt(e.port, 10) || 587,
    tls: e.tls,
    username: e.username.trim(),
    fromAddress: e.fromAddress.trim(),
    toAddresses: e.toAddresses.trim(),
  };
}

function ChannelForm({
  initial,
  onSave,
  onCancel,
  onTest,
  saving,
  testing,
  testResult,
}: {
  initial: FormState;
  onSave: (v: FormState) => void;
  onCancel: () => void;
  onTest: (v: FormState) => void;
  saving?: boolean;
  testing?: boolean;
  testResult?: { ok: boolean; error?: string } | null;
}) {
  const [form, setForm] = useState<FormState>(initial);

  function set<K extends keyof FormState>(key: K, val: FormState[K]) {
    setForm(f => ({ ...f, [key]: val }));
  }
  function setEmail<K extends keyof EmailFormState>(key: K, val: EmailFormState[K]) {
    setForm(f => ({ ...f, email: { ...f.email, [key]: val } }));
  }

  const isEmail = form.type === 'email';
  const canSave = form.name.trim() && (
    isEmail
      ? form.email.host.trim() && form.email.fromAddress.trim() && form.email.toAddresses.trim()
      : form.url.trim()
  );

  const help = !isEmail && form.type ? WEBHOOK_HELP[form.type] : null;

  return (
    <div className="space-y-4 pt-2">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="nc-name">Name</Label>
          <Input
            id="nc-name"
            value={form.name}
            onChange={e => set('name', e.target.value)}
            placeholder="e.g. Security alerts channel"
            autoFocus
          />
        </div>

        <div className="space-y-1.5">
          <Label>Type</Label>
          <Select
            value={form.type}
            onValueChange={v => set('type', v as NotificationChannelType)}
            options={CHANNEL_TYPE_OPTIONS}
            aria-label="Channel type"
          />
        </div>

        {isEmail ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="nc-host">SMTP host</Label>
              <Input
                id="nc-host"
                value={form.email.host}
                onChange={e => setEmail('host', e.target.value)}
                placeholder="smtp.gmail.com"
                className="font-mono"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="nc-port">Port</Label>
                <Input
                  id="nc-port"
                  type="number"
                  value={form.email.port}
                  onChange={e => setEmail('port', e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Encryption</Label>
                <Select
                  value={form.email.tls}
                  onValueChange={v => setEmail('tls', v as EmailChannelConfig['tls'])}
                  options={TLS_OPTIONS}
                  aria-label="Encryption"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="nc-username">Username</Label>
              <Input
                id="nc-username"
                value={form.email.username}
                onChange={e => setEmail('username', e.target.value)}
                placeholder="user@example.com (leave empty for anonymous)"
                autoComplete="username"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="nc-password">Password</Label>
              <Input
                id="nc-password"
                type="password"
                value={form.url}
                onChange={e => set('url', e.target.value)}
                placeholder="Leave empty to keep existing"
                autoComplete="current-password"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="nc-from">From address</Label>
              <Input
                id="nc-from"
                type="email"
                value={form.email.fromAddress}
                onChange={e => setEmail('fromAddress', e.target.value)}
                placeholder="rulebeat@example.com"
              />
            </div>

            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="nc-to">To addresses</Label>
              <Input
                id="nc-to"
                value={form.email.toAddresses}
                onChange={e => setEmail('toAddresses', e.target.value)}
                placeholder="team@example.com, oncall@example.com"
              />
              <FieldHint>Comma-separated list of recipients.</FieldHint>
            </div>
          </>
        ) : (
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="nc-url">URL</Label>
            <Input
              id="nc-url"
              type="url"
              value={form.url}
              onChange={e => set('url', e.target.value)}
              placeholder="https://"
              autoComplete="off"
              className="font-mono"
            />
            {help && help.href && (
              <a
                href={help.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block text-xs font-medium text-ink underline underline-offset-2 hover:no-underline"
              >
                {help.label}
              </a>
            )}
          </div>
        )}
      </div>

      {testResult && (
        <Callout tone={testResult.ok ? 'success' : 'error'}>
          {testResult.ok ? 'Test message delivered.' : (testResult.error ?? 'Delivery failed.')}
        </Callout>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" disabled={saving || !canSave} onClick={() => onSave(form)}>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          Save
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={testing || (isEmail ? !form.email.host.trim() : !form.url.trim())}
          onClick={() => onTest(form)}
        >
          {testing ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
          Send test
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function formFromSummary(channel: NotificationChannelSummary): FormState {
  const cfg = channel.emailConfig;
  return {
    name: channel.name,
    type: channel.type,
    url: '',
    email: cfg ? {
      host: cfg.host,
      port: String(cfg.port),
      tls: cfg.tls,
      username: cfg.username,
      fromAddress: cfg.fromAddress,
      toAddresses: cfg.toAddresses,
    } : DEFAULT_EMAIL,
  };
}

export function NotificationsSection({
  initialChannels,
}: {
  initialChannels: NotificationChannelSummary[];
}) {
  const [channels, setChannels] = useState<NotificationChannelSummary[]>(initialChannels);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; error?: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyByChannel, setHistoryByChannel] = useState<Record<string, NotificationDelivery[]>>({});

  function buildSaveBody(values: FormState, id?: string) {
    const base = {
      ...(id ? { id } : {}),
      name: values.name,
      type: values.type,
      url: values.url,
    };
    if (values.type === 'email') {
      return { ...base, config: emailConfigFromForm(values.email) };
    }
    return base;
  }

  function buildTestBody(values: FormState, id?: string) {
    if (id) return { id };
    if (values.type === 'email') {
      return { type: values.type, url: values.url, config: emailConfigFromForm(values.email) };
    }
    return { type: values.type, url: values.url };
  }

  async function handleCreate(values: FormState) {
    setSaving(true); setError(null);
    try {
      const res = await fetch('/api/settings/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildSaveBody(values)),
      });
      const body = await res.json() as NotificationChannelSummary & { error?: string };
      if (!res.ok) { setError(body.error ?? 'Could not create the channel.'); return; }
      setChannels(cs => [...cs, body]);
      setCreating(false);
    } catch { setError('Could not reach the server.'); }
    finally { setSaving(false); }
  }

  async function handleUpdate(id: string, values: FormState) {
    setSaving(true); setError(null);
    try {
      const res = await fetch('/api/settings/notifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildSaveBody(values, id)),
      });
      const body = await res.json() as NotificationChannelSummary & { error?: string };
      if (!res.ok) { setError(body.error ?? 'Could not update the channel.'); return; }
      setChannels(cs => cs.map(c => c.id === id ? body : c));
      setEditingId(null);
    } catch { setError('Could not reach the server.'); }
    finally { setSaving(false); }
  }

  async function handleDelete(channel: NotificationChannelSummary) {
    if (!confirm(`Delete "${channel.name}"? Any schedules using this channel will stop notifying it.`)) return;
    setError(null);
    const res = await fetch(`/api/settings/notifications?id=${encodeURIComponent(channel.id)}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json() as { error?: string };
      setError(body.error ?? 'Could not delete the channel.');
      return;
    }
    setChannels(cs => cs.filter(c => c.id !== channel.id));
  }

  async function handleTest(values: FormState, id?: string) {
    const key = id ?? '__new__';
    setTestingId(key);
    setTestResults(r => ({ ...r, [key]: undefined as unknown as { ok: boolean } }));
    try {
      const res = await fetch('/api/settings/notifications/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildTestBody(values, id)),
      });
      const body = await res.json() as { ok: boolean; error?: string };
      setTestResults(r => ({ ...r, [key]: body }));
    } catch {
      setTestResults(r => ({ ...r, [key]: { ok: false, error: 'Could not reach the server.' } }));
    } finally { setTestingId(null); }
  }

  async function handleToggleHistory(channel: NotificationChannelSummary) {
    if (historyId === channel.id) { setHistoryId(null); return; }
    setHistoryId(channel.id);
    if (historyByChannel[channel.id]) return;
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/settings/notifications/history?channelId=${encodeURIComponent(channel.id)}`);
      const body = await res.json() as NotificationDelivery[] | { error?: string };
      setHistoryByChannel(h => ({ ...h, [channel.id]: Array.isArray(body) ? body : [] }));
    } catch {
      setHistoryByChannel(h => ({ ...h, [channel.id]: [] }));
    } finally { setHistoryLoading(false); }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="size-4 text-ink-muted" />
          Notifications
        </CardTitle>
        {!creating && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => { setCreating(true); setEditingId(null); }}
          >
            <Plus className="size-3.5" />
            Add channel
          </Button>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        <p className="text-xs leading-relaxed text-ink-2">
          Define notification destinations here. Assign them to individual schedules in
          the Scans &rarr; Schedules tab, where you also set the severity threshold per schedule.
        </p>

        {error && <Callout tone="error">{error}</Callout>}

        {creating && (
          <div className="bg-surface-sunken px-4 py-4">
            <p className="mb-3 text-sm font-medium text-ink">New channel</p>
            <ChannelForm
              initial={DEFAULT_FORM}
              onSave={handleCreate}
              onCancel={() => setCreating(false)}
              onTest={values => void handleTest(values)}
              saving={saving}
              testing={testingId === '__new__'}
              testResult={testResults['__new__'] ?? null}
            />
          </div>
        )}

        {channels.length === 0 && !creating && (
          <p className="text-sm text-ink-muted">
            No notification channels yet. Add one, then assign it to a schedule.
          </p>
        )}

        {channels.length > 0 && (
          <div className="divide-y divide-border bg-surface">
            {channels.map(channel => {
              const isEditing = editingId === channel.id;
              return (
                <div key={channel.id} className="bg-surface">
                  <div className="flex items-center gap-3 px-4 py-3.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-ink">{channel.name}</span>
                        <span className="border border-border px-1.5 py-0.5 text-xs text-ink-2">
                          {CHANNEL_TYPE_LABELS[channel.type]}
                        </span>
                      </div>
                      <p className="text-xs text-ink">{channel.urlHost}</p>
                      {channel.lastError && (
                        <p className="mt-0.5 truncate text-xs text-sev-critical" title={channel.lastError}>
                          Last delivery failed: {channel.lastError.slice(0, 80)}
                        </p>
                      )}
                      {channel.lastNotifiedAt && !channel.lastError && (
                        <p className="mt-0.5 text-xs text-ink-muted">
                          Last sent {new Date(channel.lastNotifiedAt).toLocaleString()}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Send test"
                        disabled={testingId === channel.id}
                        onClick={() => void handleTest(DEFAULT_FORM, channel.id)}
                      >
                        {testingId === channel.id
                          ? <Loader2 className="size-3.5 animate-spin" />
                          : <Send className="size-3.5" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title={historyId === channel.id ? 'Hide history' : 'View history'}
                        onClick={() => void handleToggleHistory(channel)}
                      >
                        <Clock className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title={isEditing ? 'Collapse' : 'Edit channel'}
                        onClick={() => { setEditingId(isEditing ? null : channel.id); setCreating(false); }}
                      >
                        {isEditing ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Delete channel"
                        className="hover:text-sev-critical"
                        onClick={() => void handleDelete(channel)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>

                  {isEditing && (
                    <div className="border-t border-border bg-surface-sunken px-4 py-4">
                      <ChannelForm
                        initial={formFromSummary(channel)}
                        onSave={values => void handleUpdate(channel.id, values)}
                        onCancel={() => setEditingId(null)}
                        onTest={values => void handleTest(values, channel.id)}
                        saving={saving}
                        testing={testingId === channel.id}
                        testResult={testResults[channel.id] ?? null}
                      />
                    </div>
                  )}

                  {historyId === channel.id && (
                    <div className="border-t border-border bg-surface-sunken px-4 py-3.5">
                      <p className="label-grid mb-2">Recent delivery attempts</p>
                      {historyLoading && !historyByChannel[channel.id] ? (
                        <div className="flex items-center gap-2 py-1 text-xs text-ink-muted">
                          <Loader2 className="size-3.5 animate-spin" />
                          Loading history...
                        </div>
                      ) : (historyByChannel[channel.id]?.length ?? 0) === 0 ? (
                        <p className="text-xs text-ink-muted">No delivery attempts yet.</p>
                      ) : (
                        <ul className="space-y-1.5">
                          {historyByChannel[channel.id].map(d => (
                            <li key={d.id} className="flex items-start gap-2 text-xs">
                              {d.ok
                                ? <Check className="mt-0.5 size-3.5 shrink-0 text-status-ok" />
                                : <X className="mt-0.5 size-3.5 shrink-0 text-sev-critical" />}
                              <div className="min-w-0 flex-1">
                                <span className="text-ink">
                                  {new Date(d.occurredAt).toLocaleString()}
                                </span>
                                <span className="text-ink">
                                  {' — '}{d.ok ? 'delivered' : 'failed'}
                                  {d.attempts > 1 ? ` after ${d.attempts} attempts` : ''}
                                  {typeof d.findingsCount === 'number' ? `, ${d.findingsCount} finding${d.findingsCount === 1 ? '' : 's'}` : ''}
                                </span>
                                {!d.ok && d.error && (
                                  <p className="truncate text-sev-critical" title={d.error}>{d.error.slice(0, 100)}</p>
                                )}
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  {testResults[channel.id] && !isEditing && (
                    <Callout
                      tone={testResults[channel.id].ok ? 'success' : 'error'}
                      className="border-x-0 border-b-0"
                    >
                      {testResults[channel.id].ok
                        ? 'Test message delivered.'
                        : (testResults[channel.id].error ?? 'Delivery failed.')}
                    </Callout>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
