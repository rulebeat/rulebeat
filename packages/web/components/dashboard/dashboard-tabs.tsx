'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Plus, Star, Settings2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NewDashboardDialog } from '@/components/dashboard/new-dashboard-dialog';
import type { Dashboard } from '@/lib/types';

interface Props {
  dashboards: Dashboard[];
  activeId?: string;
}

/** Quick-switch tab strip rendered above a single dashboard's grid — default-first then by
 *  creation date, a `+` tab to create a new one (reusing the existing NewDashboardDialog), and a
 *  "Manage" link to the full gallery page (which owns per-card rename/duplicate/delete/set-default
 *  actions; this strip is only for fast switching + creating). */
export function DashboardTabs({ dashboards, activeId }: Props) {
  const [showNewDialog, setShowNewDialog] = useState(false);

  const sorted = [...dashboards].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return Number(b.isDefault) - Number(a.isDefault);
    return a.createdAt.localeCompare(b.createdAt);
  });

  return (
    <>
      <div
        className="scroll-x sticky top-0 z-20 flex shrink-0 items-center gap-1 border-b border-rule-strong bg-surface px-4 pt-2"
        tabIndex={0}
        role="region"
        aria-label="Dashboard tabs"
      >
        {sorted.map(d => {
          const active = d.id === activeId;
          return (
            <Link
              key={d.id}
              href={`/dashboards/${d.id}`}
              className={cn(
                '-mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                active ? 'border-ink text-ink' : 'border-transparent text-ink-2 hover:text-ink',
              )}
            >
              {d.isDefault && <Star className="size-2.5 shrink-0 fill-current" />}
              <span className="max-w-40 truncate">{d.name}</span>
            </Link>
          );
        })}

        <button
          onClick={() => setShowNewDialog(true)}
          title="New dashboard"
          className="ml-1 flex size-8 shrink-0 items-center justify-center text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
        >
          <Plus className="size-4" />
        </button>

        <Link
          href="/dashboards"
          className="mb-1 ml-auto flex shrink-0 items-center gap-1.5 border border-border px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-surface-hover hover:text-ink"
        >
          <Settings2 className="size-3.5" />Manage
        </Link>
      </div>

      {showNewDialog && (
        <NewDashboardDialog onClose={() => setShowNewDialog(false)} />
      )}
    </>
  );
}
