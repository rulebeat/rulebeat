'use client';

import { useState } from 'react';
import { GripVertical, Settings2, X, Filter } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WidgetDef } from '@/lib/types';

interface Props {
  widget: WidgetDef;
  editMode: boolean;
  /** True when the dashboard filter bar has an active filter OR this widget carries its own
   *  Scope override — shows a subtle indicator next to the title so users know this widget's
   *  numbers are scoped, not tenant-wide. */
  filtered?: boolean;
  children: React.ReactNode;
  onRemove?: () => void;
  onConfigure?: () => void;
}

export function WidgetWrapper({ widget, editMode, filtered, children, onRemove, onConfigure }: Props) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className={cn(
        'flex h-full flex-col overflow-hidden border border-border bg-surface',
        editMode && 'transition-colors hover:border-ink',
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Header */}
      <div className={cn(
        'flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5',
        editMode && 'cursor-move widget-drag-handle',
      )}>
        {editMode && (
          <GripVertical className="size-4 shrink-0 text-ink-faint" />
        )}
        <span className="title-grid flex min-w-0 flex-1 select-none items-center gap-1.5 truncate">
          <span className="truncate">{widget.title}</span>
          {filtered && (
            <span title="Scoped by dashboard or widget filters" className="flex shrink-0 items-center">
              <Filter className="size-3 text-ink" />
            </span>
          )}
        </span>
        {/* Actions — shown on hover (view mode) or always (edit mode) */}
        <div className={cn(
          'flex shrink-0 items-center gap-1 transition-opacity',
          editMode ? 'opacity-100' : (hovered ? 'opacity-100' : 'opacity-0'),
        )}>
          {onConfigure && (
            <button
              onClick={onConfigure}
              className="p-1 text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
              title={editMode ? 'Configure' : 'Configure widget'}
            >
              <Settings2 className="size-3.5" />
            </button>
          )}
          {editMode && onRemove && (
            <button
              onClick={onRemove}
              className="p-1 text-ink-muted transition-colors hover:bg-sev-critical-soft hover:text-sev-critical"
              title="Remove widget"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Content. A flex column on purpose: a child that fills and scrolls with
          `flex-1 min-h-0` (TableScroll's `fill` mode) needs a flex parent, and
          without one it grew past the tile and was silently clipped instead of
          scrolling. data-widget-body is also the box the dashboard's fit-to-content
          pass measures a widget's content against. */}
      <div data-widget-body className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </div>
  );
}
