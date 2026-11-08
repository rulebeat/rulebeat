'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LayoutDashboard, Plus, Clock, Star, MoreHorizontal, Copy, Trash2, RotateCcw, Share2, Undo2, UserRoundCog, UserRoundCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Callout } from '@/components/ui/callout';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { NewDashboardDialog } from '@/components/dashboard/new-dashboard-dialog';
import {
  DEMOTED_OWNER_NOTE, isDemotedOwner, isOwnItem, mayChangeItemWith, mayChangeVisibilityWith, ownerLabel, sectionsOf, transferControlsWith, type ItemPermissions,
} from '@/lib/item-access-model';
import { shareConfirmation } from '@/lib/item-sharing';
import { requestVisibilityChange } from '@/lib/item-sharing-client';
import { ItemTransferDialog } from '@/components/item-transfer-dialog';
import type { Dashboard } from '@/lib/types';

interface Props {
  /** The dashboards the person may open: their own, Personal or Shared, and everyone's Shared ones. */
  initialDashboards: Dashboard[];
  currentUserId: string;
  permissions: ItemPermissions;
  /** Whether Share is on, and why not when it is off. Computed on the server from `mayAct`. */
  shareControl: { allowed: boolean; reason?: string };
}

export function DashboardsGallery({ initialDashboards, currentUserId, permissions, shareControl }: Props) {
  const router = useRouter();
  const [dashboards, setDashboards] = useState(initialDashboards);
  const [showDialog, setShowDialog] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<{ dashboard: Dashboard; mode: 'hand-over' | 'take-over' } | null>(null);

  function refreshList() {
    fetch('/api/dashboards')
      .then(r => r.json())
      .then(d => setDashboards(d as Dashboard[]))
      .catch(() => {});
  }

  async function handleSetDefault(id: string) {
    setError(null);
    try {
      const res = await fetch(`/api/dashboards/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isDefault: true }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? 'Failed to set default dashboard.');
        return;
      }
      refreshList();
      router.refresh();
    } catch {
      setError('Failed to set default dashboard.');
    }
  }

  async function handleDuplicate(id: string) {
    setError(null);
    try {
      const res = await fetch(`/api/dashboards/${id}/duplicate`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? 'Failed to duplicate dashboard.');
        return;
      }
      const copy = await res.json() as Dashboard;
      router.push(`/dashboards/${copy.id}`);
      router.refresh();
    } catch {
      setError('Failed to duplicate dashboard.');
    }
  }

  async function handleDelete(d: Dashboard) {
    if (!confirm(`Delete "${d.name}"? This cannot be undone.`)) return;
    setError(null);
    try {
      const res = await fetch(`/api/dashboards/${d.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? 'Failed to delete dashboard.');
        return;
      }
      setDashboards(ds => ds.filter(x => x.id !== d.id));
      router.refresh(); // invalidate cached server data so sidebar / gallery update
    } catch {
      setError('Failed to delete dashboard.');
    }
  }

  async function handleVisibility(d: Dashboard, action: 'share' | 'unshare') {
    if (action === 'share' && !confirm(shareConfirmation('dashboard', d.name))) return;
    setError(null);
    const outcome = await requestVisibilityChange('dashboard', d.id, action);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    refreshList();
    router.refresh(); // the sidebar and the other tabs read the list from the server
  }

  async function handleRestoreStarter() {
    setRestoring(true);
    setError(null);
    try {
      const res = await fetch('/api/dashboards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: 'starter' }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? 'Failed to restore the starter dashboard.');
        return;
      }
      const created = await res.json() as Dashboard;
      router.push(`/dashboards/${created.id}`);
      router.refresh();
    } catch {
      setError('Failed to restore the starter dashboard.');
    } finally {
      setRestoring(false);
    }
  }

  const { yours, sharedByOthers } = sectionsOf({ id: currentUserId }, dashboards);

  function renderCard(d: Dashboard, tag: React.ReactNode) {
    const actor = { id: currentUserId };
    const canChange = mayChangeItemWith(actor, permissions, d);
    const canSetDefault = permissions.manage && d.visibility === 'shared' && !d.isDefault;
    const canShare = d.visibility === 'personal' && isOwnItem(actor, d);
    const canUnshare = mayChangeVisibilityWith(actor, permissions, d, 'unshare');
    const { handOver: canHandOver, takeOver: canTakeOver } = transferControlsWith(actor, permissions, d);
    return (
      <Card key={d.id} className="relative h-full overflow-visible transition-colors hover:border-ink">
        <Link href={`/dashboards/${d.id}`} className="absolute inset-0 z-0 cursor-pointer" aria-label={d.name} />
        <CardContent className="pointer-events-none flex flex-col gap-3 pb-4 pt-5">
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center border border-border bg-surface-sunken">
              <LayoutDashboard className="size-4 text-ink" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-ink">{d.name}</p>
              <div className="mt-0.5 flex min-w-0 items-center gap-2">
                {tag}
                {d.isDefault && (
                  <span className="label-grid-strong flex items-center gap-1">
                    <Star className="size-2.5 fill-current" />Default
                  </span>
                )}
              </div>
            </div>
            {/* The card is one big link (absolute, z-0); this needs its own stacking
                context above it or the overlay wins hit-testing despite pointer-events. */}
            <div className="pointer-events-auto relative z-10">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${d.name}`}>
                      <MoreHorizontal className="size-4" />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" className="w-52">
                  {canSetDefault && (
                    <DropdownMenuItem onClick={() => void handleSetDefault(d.id)}>
                      <Star />Set default
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => void handleDuplicate(d.id)}>
                    <Copy />Duplicate
                  </DropdownMenuItem>
                  {canShare && (
                    <DropdownMenuItem disabled={!shareControl.allowed} onClick={() => void handleVisibility(d, 'share')}>
                      <Share2 />Share
                    </DropdownMenuItem>
                  )}
                  {canShare && !shareControl.allowed && shareControl.reason && (
                    <p className="px-3 pb-1.5 text-xs text-ink-2">{shareControl.reason}</p>
                  )}
                  {canUnshare && (
                    <DropdownMenuItem onClick={() => void handleVisibility(d, 'unshare')}>
                      <Undo2 />Unshare
                    </DropdownMenuItem>
                  )}
                  {canHandOver && (
                    <DropdownMenuItem onClick={() => setTransfer({ dashboard: d, mode: 'hand-over' })}>
                      <UserRoundCog />Hand over
                    </DropdownMenuItem>
                  )}
                  {canTakeOver && (
                    <DropdownMenuItem onClick={() => setTransfer({ dashboard: d, mode: 'take-over' })}>
                      <UserRoundCheck />Take over
                    </DropdownMenuItem>
                  )}
                  {canChange && (
                    <DropdownMenuItem variant="destructive" onClick={() => void handleDelete(d)}>
                      <Trash2 />Delete
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          {d.description && (
            <p className="line-clamp-2 text-xs text-ink-2">{d.description}</p>
          )}
          {isDemotedOwner(actor, permissions, d) && (
            <p className="text-xs text-ink-2">{DEMOTED_OWNER_NOTE}</p>
          )}
          <div className="numeral-grid mt-auto flex items-center gap-1.5 text-xs text-ink-muted">
            <span>{d.config.widgets.length} widget{d.config.widgets.length !== 1 ? 's' : ''}</span>
            {d.config.autoRefresh ? (
              <>
                <span>·</span>
                <Clock className="size-3" />
                <span>Auto-refresh {d.config.autoRefresh}s</span>
              </>
            ) : null}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex-1 space-y-6 px-6 py-6">
      {error && <Callout tone="error">{error}</Callout>}
      <div className="flex items-center justify-between">
        <p className="numeral-grid text-sm text-ink-muted">
          {dashboards.length} dashboard{dashboards.length !== 1 ? 's' : ''}
        </p>
        <Button size="sm" className="gap-1.5" onClick={() => setShowDialog(true)}>
          <Plus className="size-3.5" />New Dashboard
        </Button>
      </div>

      {dashboards.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 border border-dashed border-rule-strong py-16">
          <LayoutDashboard className="size-8 text-ink-faint" />
          <div className="space-y-1 text-center">
            <p className="text-sm font-medium text-ink">No dashboards yet</p>
            <p className="text-xs text-ink-muted">Create a blank dashboard or restore the original starter layout.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" className="gap-1.5" onClick={() => setShowDialog(true)}>
              <Plus className="size-3.5" />Create dashboard
            </Button>
            <Button size="sm" variant="outline" className="gap-1.5" disabled={restoring} onClick={handleRestoreStarter}>
              <RotateCcw className="size-3.5" />
              {restoring ? 'Restoring…' : 'Restore starter'}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <section aria-labelledby="dashboards-yours" className="space-y-3">
            <h2 id="dashboards-yours" className="title-grid">Yours</h2>
            {yours.length === 0 ? (
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-sm text-ink-muted">You have no dashboards of your own. Create one, restore the starter, or duplicate a Shared one to start from it.</p>
                <Button size="sm" variant="outline" className="gap-1.5" disabled={restoring} onClick={handleRestoreStarter}>
                  <RotateCcw className="size-3.5" />
                  {restoring ? 'Restoring…' : 'Restore starter'}
                </Button>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {yours.map(d => renderCard(d, <Badge variant="secondary">{d.visibility === 'shared' ? 'Shared' : 'Personal'}</Badge>))}
              </div>
            )}
          </section>
          <section aria-labelledby="dashboards-shared-by-others" className="space-y-3">
            <h2 id="dashboards-shared-by-others" className="title-grid">Shared by others</h2>
            {sharedByOthers.length === 0 ? (
              <p className="text-sm text-ink-muted">No one else has shared a dashboard.</p>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {sharedByOthers.map(d => renderCard(d, <span className="truncate text-xs text-ink-muted">{ownerLabel(d.owner)}</span>))}
              </div>
            )}
          </section>
        </>
      )}

      {transfer && (
        <ItemTransferDialog
          kind="dashboard"
          mode={transfer.mode}
          id={transfer.dashboard.id}
          name={transfer.dashboard.name}
          onClose={() => setTransfer(null)}
          onDone={() => {
            refreshList();
            router.refresh(); // the sidebar and the other tabs read the list from the server
          }}
        />
      )}

      {showDialog && (
        <NewDashboardDialog
          onClose={() => {
            setShowDialog(false);
            refreshList();
          }}
        />
      )}
    </div>
  );
}
