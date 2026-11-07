'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { Severity } from '@/lib/types';

export interface SeveritySegment {
  severity: Severity;
  label: string;
  value: number;
  href: string;
  color: string;
}

/** Whether a segment is wide enough to carry its own number at 12px: about 8px a digit plus 6px of
 *  padding either side. Before the bar has been measured nothing fits, so the legend carries every
 *  count. */
export function segmentFits(value: number, total: number, width: number): boolean {
  if (width <= 0 || total <= 0) return false;
  return (width * value) / total >= String(value).length * 8 + 12;
}

/** Open findings by severity as one 24px stacked bar, in the order given (hot to neutral). A segment
 *  too narrow for its number leaves it to the legend underneath, where every count is a real link to
 *  the findings it counts. `width` overrides the measured width (for rendering without a browser). */
export function SeverityStackedBar({ segments, width }: { segments: readonly SeveritySegment[]; width?: number }) {
  const barRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(0);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    setMeasured(el.clientWidth);
    const observer = new ResizeObserver(() => setMeasured(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const barWidth = width ?? measured;
  const total = segments.reduce((sum, s) => sum + s.value, 0);

  return (
    <div className="space-y-3">
      <div ref={barRef} className="flex h-6 w-full gap-px bg-surface">
        {segments.map(s => (
          <div
            key={s.severity}
            data-severity={s.severity}
            className="flex min-w-0.5 items-center justify-center overflow-hidden text-xs font-medium text-surface"
            style={{ flex: `${s.value} 1 0`, backgroundColor: s.color }}
          >
            {segmentFits(s.value, total, barWidth) ? s.value : ''}
          </div>
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {segments.map(s => (
          <li key={s.severity}>
            <Link href={s.href} className="inline-flex items-center gap-1.5 text-sm text-ink hover:underline">
              <span className="inline-block size-2.5 shrink-0" style={{ backgroundColor: s.color }} />
              {s.label}
              <span className="numeral-grid font-medium">{s.value}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
