'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { TargetPicker } from './target-picker';
import type { Category, Rule } from '@/lib/types';
import type { ScheduleTargetType } from '@/lib/db/schedules';
import { Play, Loader2 } from 'lucide-react';

interface RunScanButtonProps {
  categories: Category[];
  rules: Rule[];
  /** Prefills the target picker from whatever the caller is currently viewing/filtering by. */
  defaultTargetType?: ScheduleTargetType;
  defaultTargetValues?: string[];
}

export function RunScanButton({ categories, rules, defaultTargetType = 'all', defaultTargetValues = [] }: RunScanButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [targetType, setTargetType] = useState<ScheduleTargetType>(defaultTargetType);
  const [targetValues, setTargetValues] = useState<Set<string>>(new Set(defaultTargetValues));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync from the caller's current filters whenever the popover is closed, so opening it
  // fresh always reflects "run what I'm currently looking at" rather than a stale prior pick.
  useEffect(() => {
    if (open) return;
    // Reset-on-close, re-syncing to the caller's current filters — not derivable render state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTargetType(defaultTargetType);
    setTargetValues(new Set(defaultTargetValues));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultTargetType, JSON.stringify(defaultTargetValues)]);

  const valid = targetType === 'all' || targetValues.size > 0;

  async function handleRun() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/api/scans/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetType, targetValues: [...targetValues] }),
      });
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        throw new Error(body.error ?? 'Failed to start scan');
      }
      setOpen(false);
      // The scan runs in the background — refresh after a delay so Results/Run History pick it
      // up, matching the schedule "Run now" UX (no request held open for the full scan).
      setTimeout(() => router.refresh(), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setRunning(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={
        <Button size="sm" className="gap-2 h-8">
          <Play className="size-3.5" />
          Run Scan
        </Button>
      } />
      <PopoverContent align="end" className="w-80 space-y-4 p-4">
        <TargetPicker
          label="Run target"
          targetType={targetType}
          targetValues={targetValues}
          onTargetTypeChange={setTargetType}
          onTargetValuesChange={setTargetValues}
          categories={categories}
          rules={rules}
        />
        {error && <p className="text-xs text-sev-critical">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button size="sm" disabled={!valid || running} onClick={() => { void handleRun(); }} className="gap-1.5">
            {running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            {running ? 'Starting…' : 'Run'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
