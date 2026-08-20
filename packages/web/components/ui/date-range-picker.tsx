'use client';

import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { dateWindowLabel, resolveDateWindow, todayKey, type DateWindow } from '@/lib/date-window';

const PRESETS: Array<{ days: number; label: string }> = [
  { days: 1, label: '24h' },
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
];

interface Props {
  value: DateWindow;
  onChange: (w: DateWindow) => void;
}

/** Shared window control — 24h/7d/30d presets (rolling, always relative to "now" whenever
 *  resolved) plus a "Custom" option opening a small popover with two native date inputs for a
 *  fixed calendar range. Used by both the dashboard filter bar and the Scans page. Follows the
 *  same portal + click-outside pattern as ChecklistDropdown (components/ui/checklist-dropdown.tsx). */
export function DateRangePicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');

  const isCustom = value.mode === 'custom';

  function openPicker() {
    const resolved = resolveDateWindow(value);
    setDraftFrom(resolved.from);
    setDraftTo(resolved.to);
    setRect(btnRef.current?.getBoundingClientRect() ?? null);
    setOpen(true);
  }

  function applyCustom() {
    onChange({ mode: 'custom', from: draftFrom, to: draftTo });
    setOpen(false);
  }

  return (
    /* A segmented control, so the segments share one frame and are separated by a
       single hairline. The chosen window is marked by inversion, not by a colour:
       colour in this product means severity. */
    <div className="flex h-9 shrink-0 items-center border border-rule-strong">
      {PRESETS.map(p => (
        <button
          key={p.days}
          type="button"
          aria-pressed={value.mode === 'relative' && value.days === p.days}
          onClick={() => onChange({ mode: 'relative', days: p.days })}
          className={cn(
            'numeral-grid h-full border-l border-rule-strong px-3 text-xs font-medium transition-colors first:border-l-0',
            value.mode === 'relative' && value.days === p.days
              ? 'bg-ink text-surface'
              : 'text-ink-2 hover:bg-surface-hover hover:text-ink',
          )}
        >
          {p.label}
        </button>
      ))}
      <button
        ref={btnRef}
        type="button"
        aria-pressed={isCustom}
        onClick={() => (open ? setOpen(false) : openPicker())}
        className={cn(
          'flex h-full items-center gap-1 border-l border-rule-strong px-3 text-xs font-medium transition-colors',
          isCustom ? 'bg-ink text-surface' : 'text-ink-2 hover:bg-surface-hover hover:text-ink',
        )}
      >
        {isCustom ? dateWindowLabel(value) : 'Custom'}
        <ChevronDown className="size-3" />
      </button>
      {open && rect && createPortal(
        <>
          <div className="fixed inset-0 z-[999]" onMouseDown={e => { e.stopPropagation(); setOpen(false); }} />
          <div
            style={{ position: 'fixed', left: Math.min(rect.left, window.innerWidth - 260), top: rect.bottom + 4, width: 240, zIndex: 1000 }}
            className="space-y-2.5 border border-rule-strong bg-surface p-3 shadow-overlay"
            onMouseDown={e => e.stopPropagation()}
          >
            <div className="space-y-1">
              <Label htmlFor="date-range-from">From</Label>
              <Input
                id="date-range-from"
                type="date"
                inputSize="sm"
                value={draftFrom}
                max={draftTo || todayKey()}
                onChange={e => setDraftFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="date-range-to">To</Label>
              <Input
                id="date-range-to"
                type="date"
                inputSize="sm"
                value={draftTo}
                min={draftFrom}
                max={todayKey()}
                onChange={e => setDraftTo(e.target.value)}
              />
            </div>
            <Button size="sm" className="w-full" onClick={applyCustom} disabled={!draftFrom || !draftTo}>
              Apply
            </Button>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
