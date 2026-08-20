'use client';

import { useEffect, useMemo, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardAction } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ToggleChip } from '@/components/ui/toggle-chip';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableScroll,
} from '@/components/ui/table';
import { RunStatusDot } from '@/components/scans/run-status-dot';
import { TargetPicker } from '@/components/scans/target-picker';
import { describeTarget } from '@/lib/target-describe';
import { cn } from '@/lib/utils';
import type { Category, Rule, Severity } from '@/lib/types';
import type { Schedule, ScheduleTargetType, RecurrenceType, ScheduleEndType } from '@/lib/db/schedules';
import type { ScheduleRun } from '@/lib/schedule-runs';
import type { ScheduleChannelLink } from '@/lib/db/schedule-notification-channels';
import type { NotificationChannelSummary } from '@/lib/db/notification-channels';
import { Plus, Trash2, Pencil, Check, X, Play, Clock, ChevronDown, ChevronUp } from 'lucide-react';

export type ScheduleWithLastRun = Schedule & {
  lastRun: ScheduleRun | null;
  notificationLinks: ScheduleChannelLink[];
};

const CHANNEL_TYPE_LABELS: Record<string, string> = {
  teams: 'Teams',
  slack: 'Slack',
  webhook: 'Webhook',
};

const SEVERITY_OPTIONS: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const SEVERITY_LABELS: Record<Severity, string> = {
  critical: 'Critical only',
  high: 'High and above',
  medium: 'Medium and above',
  low: 'Low and above',
  info: 'All severities',
};
const SEVERITY_SELECT_OPTIONS = SEVERITY_OPTIONS.map(s => ({ value: s, label: SEVERITY_LABELS[s] }));

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function defaultStartAt(): string {
  const d = new Date(Date.now() + 5 * 60_000);
  d.setSeconds(0, 0);
  return d.toISOString();
}

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const diffMs = new Date(iso).getTime() - Date.now();
  const future = diffMs >= 0;
  const mins = Math.round(Math.abs(diffMs) / 60000);
  let text: string;
  if (mins < 1) return 'now';
  else if (mins < 60) text = `${mins}m`;
  else if (mins < 1440) text = `${Math.round(mins / 60)}h`;
  else text = `${Math.round(mins / 1440)}d`;
  return future ? `in ${text}` : `${text} ago`;
}

function describeRecurrence(s: Pick<Schedule, 'recurrenceType' | 'interval' | 'daysOfWeek' | 'dayOfMonth' | 'startAt'>): string {
  const startDate = new Date(s.startAt);
  const dateLabel = startDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const timeLabel = startDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  switch (s.recurrenceType) {
    case 'once': return `Once on ${dateLabel} at ${timeLabel}`;
    case 'hourly': return s.interval === 1 ? `Every hour` : `Every ${s.interval} hours`;
    case 'daily': return s.interval === 1 ? `Every day at ${timeLabel}` : `Every ${s.interval} days at ${timeLabel}`;
    case 'weekly': {
      const days = (s.daysOfWeek?.length ? s.daysOfWeek : [startDate.getDay()]).slice().sort().map(d => WEEKDAY_LABELS[d]).join(', ');
      return `Every ${s.interval === 1 ? '' : `${s.interval} `}week${s.interval === 1 ? '' : 's'} on ${days} at ${timeLabel}`;
    }
    case 'monthly': {
      const day = s.dayOfMonth ?? startDate.getDate();
      return `Day ${day} of every ${s.interval === 1 ? '' : `${s.interval} `}month${s.interval === 1 ? '' : 's'} at ${timeLabel}`;
    }
  }
}

interface ScheduleFormValues {
  name: string;
  targetType: ScheduleTargetType;
  targetValues: string[];
  recurrenceType: RecurrenceType;
  interval: number;
  daysOfWeek: number[];
  dayOfMonth: number;
  startAt: string; // datetime-local value
  endType: ScheduleEndType;
  endDate: string; // date value
  notificationLinks: ScheduleChannelLink[];
}

function EditRow({
  initial, categories, rules, channels, onSave, onCancel, saving,
}: {
  initial: ScheduleFormValues;
  categories: Category[];
  rules: Rule[];
  channels: NotificationChannelSummary[];
  onSave: (v: ScheduleFormValues) => void;
  onCancel: () => void;
  saving?: boolean;
}) {
  const [name, setName] = useState(initial.name);
  const [targetType, setTargetType] = useState<ScheduleTargetType>(initial.targetType);
  const [targetValues, setTargetValues] = useState<Set<string>>(new Set(initial.targetValues));
  const [recurrenceType, setRecurrenceType] = useState<RecurrenceType>(initial.recurrenceType);
  const [interval, setInterval_] = useState(initial.interval);
  const [daysOfWeek, setDaysOfWeek] = useState<Set<number>>(new Set(initial.daysOfWeek));
  const [dayOfMonth, setDayOfMonth] = useState(initial.dayOfMonth);
  const [startAt, setStartAt] = useState(initial.startAt);
  const [endType, setEndType] = useState<ScheduleEndType>(initial.endType);
  const [endDate, setEndDate] = useState(initial.endDate);
  const [notifLinks, setNotifLinks] = useState<ScheduleChannelLink[]>(initial.notificationLinks);

  const [scopeOpen, setScopeOpen] = useState<Set<string>>(new Set());

  function toggleChannel(channelId: string) {
    setNotifLinks(links => {
      const exists = links.some(l => l.channelId === channelId);
      if (exists) return links.filter(l => l.channelId !== channelId);
      return [...links, { channelId, minSeverity: 'high', categoryIds: null, subscriptionIds: null }];
    });
  }

  function setSeverity(channelId: string, minSeverity: Severity) {
    setNotifLinks(links => links.map(l => l.channelId === channelId ? { ...l, minSeverity } : l));
  }

  function toggleCategory(channelId: string, categoryId: string) {
    setNotifLinks(links => links.map(l => {
      if (l.channelId !== channelId) return l;
      const current = l.categoryIds ?? [];
      const next = current.includes(categoryId) ? current.filter(c => c !== categoryId) : [...current, categoryId];
      return { ...l, categoryIds: next.length === 0 ? null : next };
    }));
  }

  function setSubscriptionIds(channelId: string, value: string) {
    const ids = value.split(',').map(s => s.trim()).filter(Boolean);
    setNotifLinks(links => links.map(l =>
      l.channelId === channelId ? { ...l, subscriptionIds: ids.length === 0 ? null : ids } : l,
    ));
  }

  function toggleScope(channelId: string) {
    setScopeOpen(s => {
      const next = new Set(s);
      if (next.has(channelId)) next.delete(channelId); else next.add(channelId);
      return next;
    });
  }

  function toggleDay(day: number) {
    setDaysOfWeek(s => {
      const next = new Set(s);
      if (next.has(day)) next.delete(day); else next.add(day);
      return next;
    });
  }

  const valid = name.trim().length > 0
    && (targetType === 'all' || targetValues.size > 0)
    && (recurrenceType !== 'weekly' || daysOfWeek.size > 0)
    && (endType !== 'on_date' || !!endDate);

  return (
    /* Raw <tr>: this row spans every column, so the shared TableRow/TableCell
       pair would only add cell styling it immediately has to undo. */
    <tr className="border-b border-border bg-surface-sunken last:border-0">
      <td colSpan={6} className="px-4 py-4">
        <div className="flex max-w-2xl flex-col gap-5">
          <div className="space-y-1.5">
            <Label htmlFor="schedule-name">Name</Label>
            <Input
              id="schedule-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Nightly security scan"
              autoFocus
            />
          </div>

          {/* Target */}
          <TargetPicker
            label="Scan target"
            targetType={targetType}
            targetValues={targetValues}
            onTargetTypeChange={setTargetType}
            onTargetValuesChange={setTargetValues}
            categories={categories}
            rules={rules}
          />

          {/* Start */}
          <div className="space-y-1.5">
            <Label htmlFor="schedule-start" className="label-grid-strong">Start</Label>
            <Input
              id="schedule-start"
              type="datetime-local"
              value={startAt}
              onChange={e => setStartAt(e.target.value)}
              className="w-auto"
            />
          </div>

          {/* Recurrence pattern — Outlook-style */}
          <div>
            <Label className="label-grid-strong mb-1.5 block">Repeat</Label>
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              {([
                ['once', 'Does not repeat'],
                ['hourly', 'Hourly'],
                ['daily', 'Daily'],
                ['weekly', 'Weekly'],
                ['monthly', 'Monthly'],
              ] as [RecurrenceType, string][]).map(([value, label]) => (
                <ToggleChip
                  key={value}
                  selected={recurrenceType === value}
                  onClick={() => setRecurrenceType(value)}
                >
                  {label}
                </ToggleChip>
              ))}
            </div>

            {recurrenceType === 'hourly' && (
              <div className="flex items-center gap-2 text-sm text-ink-2">
                <span>Every</span>
                <Input
                  type="number" min={1} value={interval} inputSize="sm"
                  onChange={e => setInterval_(Math.max(1, parseInt(e.target.value, 10) || 1))}
                  className="w-16 text-center"
                />
                <span>hour{interval === 1 ? '' : 's'}</span>
              </div>
            )}

            {recurrenceType === 'daily' && (
              <div className="flex items-center gap-2 text-sm text-ink-2">
                <span>Every</span>
                <Input
                  type="number" min={1} value={interval} inputSize="sm"
                  onChange={e => setInterval_(Math.max(1, parseInt(e.target.value, 10) || 1))}
                  className="w-16 text-center"
                />
                <span>day{interval === 1 ? '' : 's'}</span>
              </div>
            )}

            {recurrenceType === 'weekly' && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-ink-2">
                  <span>Every</span>
                  <Input
                    type="number" min={1} value={interval} inputSize="sm"
                    onChange={e => setInterval_(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    className="w-16 text-center"
                  />
                  <span>week{interval === 1 ? '' : 's'} on:</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {WEEKDAY_LABELS.map((label, day) => (
                    <ToggleChip
                      key={day}
                      selected={daysOfWeek.has(day)}
                      onClick={() => toggleDay(day)}
                      className="w-11 px-0"
                    >
                      {label}
                    </ToggleChip>
                  ))}
                </div>
              </div>
            )}

            {recurrenceType === 'monthly' && (
              <div className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
                <span>Day</span>
                <Input
                  type="number" min={1} max={31} value={dayOfMonth} inputSize="sm"
                  onChange={e => setDayOfMonth(Math.min(31, Math.max(1, parseInt(e.target.value, 10) || 1)))}
                  className="w-16 text-center"
                />
                <span>of every</span>
                <Input
                  type="number" min={1} value={interval} inputSize="sm"
                  onChange={e => setInterval_(Math.max(1, parseInt(e.target.value, 10) || 1))}
                  className="w-16 text-center"
                />
                <span>month{interval === 1 ? '' : 's'}</span>
              </div>
            )}
          </div>

          {/* End */}
          {recurrenceType !== 'once' && (
            <div>
              <Label className="label-grid-strong mb-1.5 block">End</Label>
              <div className="flex items-center gap-4 text-sm text-ink-2">
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input type="radio" checked={endType === 'never'} onChange={() => setEndType('never')} className="accent-ink" />
                  Never
                </label>
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input type="radio" checked={endType === 'on_date'} onChange={() => setEndType('on_date')} className="accent-ink" />
                  On
                </label>
                {endType === 'on_date' && (
                  <Input
                    type="date"
                    inputSize="sm"
                    value={endDate}
                    onChange={e => setEndDate(e.target.value)}
                    className="w-auto"
                  />
                )}
              </div>
            </div>
          )}

          <div>
              <Label className="label-grid-strong mb-2 block">Notifications</Label>
              {channels.length === 0 ? (
                <p className="text-xs text-ink-2">
                  No notification channels configured. Add one in{' '}
                  <a href="/settings" className="font-medium text-ink underline underline-offset-2 hover:no-underline">Settings → Notifications</a>{' '}
                  to enable alerts for this schedule.
                </p>
              ) : (
              <>
              <p className="mb-2.5 text-xs text-ink-2">
                Send a message when this scan finds new findings at or above the chosen severity.
              </p>
              <div className="space-y-2">
                {channels.map(ch => {
                  const link = notifLinks.find(l => l.channelId === ch.id);
                  const checked = !!link;
                  const scopeExpanded = scopeOpen.has(ch.id);
                  return (
                    <div key={ch.id}>
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          id={`notif-${ch.id}`}
                          checked={checked}
                          onChange={() => toggleChannel(ch.id)}
                          className="size-3.5 shrink-0 accent-ink"
                        />
                        <label htmlFor={`notif-${ch.id}`} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm text-ink">
                          <span className="truncate font-medium">{ch.name}</span>
                          <span className="shrink-0 text-xs text-ink-2">{CHANNEL_TYPE_LABELS[ch.type] ?? ch.type}</span>
                        </label>
                        {checked && (
                          <>
                            {/* The trigger is w-full by design, so it needs a block
                                parent with a real width or it collapses to its chevron. */}
                            <div className="w-32 shrink-0">
                              <Select
                                value={link.minSeverity}
                                onValueChange={v => setSeverity(ch.id, v as Severity)}
                                options={SEVERITY_SELECT_OPTIONS}
                                size="sm"
                                aria-label="Notify when severity is at least"
                              />
                            </div>
                            <ToggleChip
                              size="sm"
                              selected={!!(link.categoryIds || link.subscriptionIds)}
                              title={scopeExpanded ? 'Hide scope' : 'Narrow scope by category or subscription'}
                              onClick={() => toggleScope(ch.id)}
                            >
                              Scope
                              {scopeExpanded ? <ChevronUp /> : <ChevronDown />}
                            </ToggleChip>
                          </>
                        )}
                      </div>

                      {checked && scopeExpanded && (
                        <div className="ml-7 mt-2 space-y-3 border-l border-border pl-3">
                          <div>
                            <p className="mb-1.5 text-xs text-ink-2">Categories (empty = all)</p>
                            <div className="flex flex-wrap gap-1.5">
                              {categories.map(cat => (
                                <ToggleChip
                                  key={cat.id}
                                  size="sm"
                                  selected={link.categoryIds ? link.categoryIds.includes(cat.id) : false}
                                  onClick={() => toggleCategory(ch.id, cat.id)}
                                >
                                  {cat.label}
                                </ToggleChip>
                              ))}
                            </div>
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor={`notif-subs-${ch.id}`} className="block text-xs font-normal normal-case tracking-normal text-ink-2">
                              Subscription IDs (comma-separated, empty = all)
                            </Label>
                            <Input
                              id={`notif-subs-${ch.id}`}
                              inputSize="sm"
                              value={link.subscriptionIds ? link.subscriptionIds.join(', ') : ''}
                              onChange={e => setSubscriptionIds(ch.id, e.target.value)}
                              placeholder="All subscriptions"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              </>
              )}
            </div>

          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              disabled={saving || !valid}
              onClick={() => onSave({
                name: name.trim(),
                targetType,
                targetValues: [...targetValues],
                recurrenceType,
                interval,
                daysOfWeek: [...daysOfWeek],
                dayOfMonth,
                startAt,
                endType,
                endDate,
                notificationLinks: notifLinks,
              })}
            >
              <Check className="size-3.5" />
              Save
            </Button>
            <Button size="sm" variant="outline" onClick={onCancel}>
              <X className="size-3.5" />
              Cancel
            </Button>
          </div>
        </div>
      </td>
    </tr>
  );
}

export function SchedulesTab({ initialSchedules, categories, rules, channels, canEdit }: {
  initialSchedules: ScheduleWithLastRun[];
  categories: Category[];
  rules: Rule[];
  /** Available notification channels (admin-loaded). Empty if viewer has no notifications:manage. */
  channels: NotificationChannelSummary[];
  canEdit: boolean;
}) {
  const [schedules, setSchedules] = useState<ScheduleWithLastRun[]>(initialSchedules);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const categoryById = useMemo(() => new Map(categories.map(c => [c.id, c])), [categories]);
  const ruleById = useMemo(() => new Map(rules.map(r => [r.id, r])), [rules]);

  // The scheduler runs server-side on its own 30s tick — as a scheduled time passes, the row's
  // nextRunAt/lastRun only reflect reality once the client re-fetches. Without this, a page left
  // open would show a schedule's next run stuck "X ago" forever after it fires, even though the
  // server already ran it and computed the following occurrence. Skipped while a row is being
  // edited so an in-progress form isn't clobbered by an incoming refetch.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (editingId === null && !creating) void refresh();
    }, 15_000);
    return () => window.clearInterval(id);
  }, [editingId, creating]);

  function toPayload(v: ScheduleFormValues) {
    return {
      name: v.name,
      targetType: v.targetType,
      targetValues: v.targetValues,
      recurrenceType: v.recurrenceType,
      interval: v.interval,
      daysOfWeek: v.recurrenceType === 'weekly' ? v.daysOfWeek : null,
      dayOfMonth: v.recurrenceType === 'monthly' ? v.dayOfMonth : null,
      startAt: new Date(v.startAt).toISOString(),
      endType: v.endType,
      endDate: v.endType === 'on_date' ? v.endDate : null,
      notificationLinks: v.notificationLinks,
    };
  }

  async function refresh() {
    const res = await fetch('/api/schedules');
    if (!res.ok) return;
    setSchedules(await res.json() as ScheduleWithLastRun[]);
  }

  async function handleCreate(v: ScheduleFormValues) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toPayload(v)),
      });
      const body = await res.json() as { error?: string };
      if (!res.ok) { setError(body.error ?? 'Failed to create schedule'); return; }
      await refresh();
      setCreating(false);
    } finally { setSaving(false); }
  }

  async function handleUpdate(id: string, v: ScheduleFormValues) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/schedules/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toPayload(v)),
      });
      const body = await res.json() as { error?: string };
      if (!res.ok) { setError(body.error ?? 'Failed to update schedule'); return; }
      await refresh();
      setEditingId(null);
    } finally { setSaving(false); }
  }

  async function handleToggleEnabled(schedule: ScheduleWithLastRun) {
    setError(null);
    try {
      const res = await fetch(`/api/schedules/${encodeURIComponent(schedule.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !schedule.enabled }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? 'Failed to update schedule');
        return;
      }
      await refresh();
    } catch {
      setError('Failed to update schedule');
    }
  }

  async function handleDelete(schedule: ScheduleWithLastRun) {
    if (!confirm(`Delete schedule "${schedule.name}"?`)) return;
    setError(null);
    const res = await fetch(`/api/schedules/${encodeURIComponent(schedule.id)}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json() as { error?: string };
      setError(body.error ?? 'Failed to delete schedule');
      return;
    }
    setSchedules(ss => ss.filter(s => s.id !== schedule.id));
  }

  async function handleRunNow(schedule: ScheduleWithLastRun) {
    setRunningId(schedule.id);
    setError(null);
    // On success, runningId stays set until the delayed refresh below clears it (giving the
    // server a moment to start the run before reflecting it). On failure it must clear right
    // away in the `finally`, or the Play button stays disabled forever.
    let succeeded = false;
    try {
      const res = await fetch(`/api/schedules/${encodeURIComponent(schedule.id)}/run`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? 'Failed to run schedule');
        return;
      }
      succeeded = true;
      setTimeout(() => { void refresh(); setRunningId(null); }, 4000);
    } catch {
      setError('Failed to run schedule');
    } finally {
      if (!succeeded) setRunningId(null);
    }
  }

  function editValuesFor(s: ScheduleWithLastRun): ScheduleFormValues {
    return {
      name: s.name,
      targetType: s.targetType,
      targetValues: s.targetValues,
      recurrenceType: s.recurrenceType,
      interval: s.interval,
      daysOfWeek: s.daysOfWeek ?? [new Date(s.startAt).getDay()],
      dayOfMonth: s.dayOfMonth ?? new Date(s.startAt).getDate(),
      startAt: toDatetimeLocal(s.startAt),
      endType: s.endType,
      endDate: s.endDate ?? '',
      notificationLinks: s.notificationLinks,
    };
  }

  const newDefaults: ScheduleFormValues = {
    name: '',
    targetType: 'all',
    targetValues: [],
    recurrenceType: 'daily',
    interval: 1,
    daysOfWeek: [new Date().getDay()],
    dayOfMonth: new Date().getDate(),
    startAt: toDatetimeLocal(defaultStartAt()),
    endType: 'never',
    endDate: '',
    notificationLinks: [],
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Scheduled Scans</CardTitle>
        {!creating && canEdit && (
          <CardAction>
            <Button size="sm" variant="outline" onClick={() => { setCreating(true); setEditingId(null); }}>
              <Plus className="size-3.5" />
              New schedule
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {error && <Callout tone="error" className="border-x-0 border-t-0">{error}</Callout>}
        {schedules.length === 0 && !creating ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <Clock className="size-6 text-ink-muted" />
            <p className="text-sm text-ink-muted">No schedules yet. Scans only run when you click Run Scan.</p>
          </div>
        ) : (
          <TableScroll>
            <Table>
              {/* The header is hidden while a row is being edited: the edit form
                  spans every column, so leaving column names floating above an
                  unrelated form reads as a broken table. */}
              {!editingId && !creating && (
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Repeats</TableHead>
                    <TableHead>Next run</TableHead>
                    <TableHead>Last run</TableHead>
                    <TableHead shrink />
                  </TableRow>
                </TableHeader>
              )}
              <TableBody>
                {schedules.map(s => {
                  if (editingId === s.id) {
                    return (
                      <EditRow
                        key={s.id}
                        categories={categories}
                        rules={rules}
                        channels={channels}
                        initial={editValuesFor(s)}
                        onSave={v => { void handleUpdate(s.id, v); }}
                        onCancel={() => setEditingId(null)}
                        saving={saving}
                      />
                    );
                  }
                  return (
                    <TableRow key={s.id} className={cn('group', !s.enabled && 'opacity-60')}>
                      <TableCell className="font-medium text-ink">{s.name}</TableCell>
                      <TableCell className="max-w-56 truncate">{describeTarget(s, categoryById, ruleById)}</TableCell>
                      <TableCell>{describeRecurrence(s)}</TableCell>
                      <TableCell>{s.enabled ? relativeTime(s.nextRunAt) : '—'}</TableCell>
                      <TableCell>
                        {s.lastRun ? (
                          <span className="inline-flex items-center gap-1.5">
                            <RunStatusDot status={s.lastRun.status} />
                            {relativeTime(s.lastRun.startedAt)}
                          </span>
                        ) : (
                          'never'
                        )}
                      </TableCell>
                      <TableCell shrink>
                        <div className="flex items-center justify-end gap-1">
                          <Switch
                            checked={s.enabled}
                            disabled={!canEdit}
                            onCheckedChange={() => { void handleToggleEnabled(s); }}
                            title={canEdit ? (s.enabled ? 'Disable schedule' : 'Enable schedule') : 'Read-only access'}
                          />
                          {canEdit && (
                            <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                              <Button
                                variant="ghost" size="icon-sm" title="Run now"
                                disabled={runningId === s.id}
                                onClick={() => { void handleRunNow(s); }}
                              >
                                <Play className="size-3.5" />
                              </Button>
                              <Button
                                variant="ghost" size="icon-sm" title="Edit schedule"
                                onClick={() => { setEditingId(s.id); setCreating(false); }}
                              >
                                <Pencil className="size-3.5" />
                              </Button>
                              <Button
                                variant="ghost" size="icon-sm" title="Delete schedule"
                                className="hover:text-sev-critical"
                                onClick={() => { void handleDelete(s); }}
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            </div>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {creating && (
                  <EditRow
                    categories={categories}
                    rules={rules}
                    channels={channels}
                    initial={newDefaults}
                    onSave={v => { void handleCreate(v); }}
                    onCancel={() => setCreating(false)}
                    saving={saving}
                  />
                )}
              </TableBody>
            </Table>
          </TableScroll>
        )}
      </CardContent>
    </Card>
  );
}
