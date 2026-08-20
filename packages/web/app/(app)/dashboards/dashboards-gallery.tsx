'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LayoutDashboard, Plus, Clock, Star, MoreHorizontal, Copy, Trash2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Callout } from '@/components/ui/callout';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { NewDashboardDialog } from '@/components/dashboard/new-dashboard-dialog';
import type { Dashboard } from '@/lib/types';

interface Props { initialDashboards: Dashboard[] }

export function DashboardsGallery({ initialDashboards }: Props) {
  const router = useRouter();
  const [dashboards, setDashboards] = useState(initialDashboards);
  const [showDialog, setShowDialog] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {dashboards.map(d => (
            <Card key={d.id} className="relative h-full overflow-visible transition-colors hover:border-ink">
              <Link href={`/dashboards/${d.id}`} className="absolute inset-0 z-0 cursor-pointer" aria-label={d.name} />
              <CardContent className="pointer-events-none flex flex-col gap-3 pb-4 pt-5">
                <div className="flex items-start gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center border border-border bg-surface-sunken">
                    <LayoutDashboard className="size-4 text-ink" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink">{d.name}</p>
                    {d.isDefault && (
                      <span className="label-grid-strong mt-0.5 flex items-center gap-1">
                        <Star className="size-2.5 fill-current" />Default
                      </span>
                    )}
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
                      <DropdownMenuContent align="end" className="w-40">
                        {!d.isDefault && (
                          <DropdownMenuItem onClick={() => void handleSetDefault(d.id)}>
                            <Star />Set default
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onClick={() => void handleDuplicate(d.id)}>
                          <Copy />Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onClick={() => void handleDelete(d)}>
                          <Trash2 />Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
                {d.description && (
                  <p className="line-clamp-2 text-xs text-ink-2">{d.description}</p>
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
          ))}
        </div>
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
