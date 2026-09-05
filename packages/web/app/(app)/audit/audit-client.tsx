'use client';

import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableScroll,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import type { AuditEntry, AuditEntityType } from '@/lib/db/audit';
import {
  ChevronDown, ChevronRight, ChevronLeft, ScrollText, Download,
  FileCode, EyeOff, CalendarClock, Folder, LayoutDashboard, Radar, Users, LogIn, Cloud, KeyRound,
  ShieldCheck, Bell, Compass, Database, Search, Terminal,
  type LucideIcon,
} from 'lucide-react';

export const PAGE_SIZE = 50;

const ENTITY_ICONS: Record<AuditEntityType, LucideIcon> = {
  rule: FileCode,
  suppression: EyeOff,
  schedule: CalendarClock,
  category: Folder,
  dashboard: LayoutDashboard,
  scan: Radar,
  user: Users,
  auth: LogIn,
  azure_connection: Cloud,
  log_analytics_workspace: Search,
  local_account: KeyRound,
  sign_in_config: ShieldCheck,
  notification_channel: Bell,
  onboarding: Compass,
  schema_cache: Database,
  query: Terminal,
};

// Destructive and access-changing actions are tinted so they stand out when scanning the list —
// which is exactly what someone opens this page to look for.
const NOTABLE_ACTIONS = new Set([
  'rule.delete', 'rule.clear_findings', 'suppression.create', 'schedule.delete', 'category.delete',
  'dashboard.delete', 'user.remove', 'user.role_change', 'user.default_role_change',
  'user.invite_claimed',
  'user.password_reset', 'user.password_removed', 'auth.locked_out',
  'sign_in_config.delete', 'sign_in_config.policy_change',
]);

function formatWhen(iso: string): string {
  const then = new Date(iso).getTime();
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function EntryRow({ entry }: { entry: AuditEntry }) {
  const [open, setOpen] = useState(false);
  const Icon = entry.entityType ? ENTITY_ICONS[entry.entityType] : ScrollText;
  const hasDetails = entry.details !== null && Object.keys(entry.details).length > 0;

  return (
    <>
      <TableRow
        className={cn('group', hasDetails && 'cursor-pointer')}
        onClick={() => hasDetails && setOpen(o => !o)}
      >
        <TableCell shrink>
          {hasDetails ? (
            open
              ? <ChevronDown className="size-3.5 text-ink-muted" />
              : <ChevronRight className="size-3.5 text-ink-muted" />
          ) : <span className="block w-3.5" />}
        </TableCell>
        <TableCell shrink className="numeral-grid text-xs" title={new Date(entry.occurredAt).toLocaleString()}>
          {formatWhen(entry.occurredAt)}
        </TableCell>
        <TableCell className="text-ink">{entry.actorEmail}</TableCell>
        <TableCell shrink>
          {/* Everything on this page is an action, so the ordinary ones stay neutral.
              Only the destructive and access-changing ones carry a hue, which is what
              someone opening an audit log is scanning for. */}
          <span className={cn(
            'inline-flex w-fit items-center gap-1.5 border px-1.5 py-0.5 font-mono text-xs font-medium',
            NOTABLE_ACTIONS.has(entry.action)
              ? 'border-status-warn/40 text-status-warn'
              : 'border-border text-ink-2',
          )}>
            <Icon className="size-2.5 shrink-0" />
            {entry.action}
          </span>
        </TableCell>
        <TableCell className="text-ink">{entry.summary}</TableCell>
      </TableRow>
      {open && hasDetails && (
        <TableRow className="bg-surface-sunken">
          <TableCell colSpan={5} className="px-4 pb-4 pt-1">
            <dl className="ml-8 grid max-w-xl grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              {Object.entries(entry.details!).map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-xs text-ink-2">{key}</dt>
                  <dd className="break-all font-mono text-xs text-ink">
                    {Array.isArray(value) ? (value.length ? value.join(', ') : '—') : String(value)}
                  </dd>
                </div>
              ))}
            </dl>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export function AuditClient({
  initialEntries, initialTotal,
}: {
  initialEntries: AuditEntry[];
  initialTotal: number;
}) {
  const [entries, setEntries] = useState(initialEntries);
  const [total, setTotal] = useState(initialTotal);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lastPage = Math.max(Math.ceil(total / PAGE_SIZE) - 1, 0);

  async function goToPage(next: number) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/audit?limit=${PAGE_SIZE}&offset=${next * PAGE_SIZE}`);
      const body = await res.json() as { entries?: AuditEntry[]; total?: number; error?: string };
      if (!res.ok) { setError(body.error ?? 'Failed to load the audit log'); return; }
      setEntries(body.entries ?? []);
      setTotal(body.total ?? 0);
      setPage(next);
    } finally { setLoading(false); }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {total === 0 ? 'No activity yet' : `${total.toLocaleString()} ${total === 1 ? 'entry' : 'entries'}`}
        </CardTitle>
        {total > 0 && (
          <Button variant="outline" size="xs" className="gap-1" render={<a href="/api/audit/export" />}>
            <Download className="size-3" />
            Export CSV
          </Button>
        )}
        {total > PAGE_SIZE && (
          <div className="flex items-center gap-2">
            <span className="numeral-grid text-xs text-ink-muted">Page {page + 1} of {lastPage + 1}</span>
            <Button
              variant="outline" size="icon-sm" title="Newer"
              disabled={page === 0 || loading}
              onClick={() => { void goToPage(page - 1); }}
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <Button
              variant="outline" size="icon-sm" title="Older"
              disabled={page >= lastPage || loading}
              onClick={() => { void goToPage(page + 1); }}
            >
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {error && <Callout tone="error" className="border-x-0 border-t-0">{error}</Callout>}
        {entries.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-16">
            <ScrollText className="mb-3 size-6 text-ink-muted" />
            <p className="text-sm text-ink">Nothing has been recorded yet.</p>
            <p className="mt-1 text-xs text-ink-muted">
              Rule edits, suppressions, schedule changes, scans and role changes all appear here.
            </p>
          </div>
        ) : (
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead shrink />
                  <TableHead shrink>When</TableHead>
                  <TableHead>Who</TableHead>
                  <TableHead shrink>Action</TableHead>
                  <TableHead>What</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map(entry => <EntryRow key={entry.id} entry={entry} />)}
              </TableBody>
            </Table>
          </TableScroll>
        )}
      </CardContent>
    </Card>
  );
}
