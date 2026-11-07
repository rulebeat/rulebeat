import Link from 'next/link';
import { ChartDataTable } from '@/components/dashboard/chart-data-table';

export interface AgeBand {
  key: string;
  label: string;
  count: number;
  href: string;
}

/** Open findings by how long they have been open: one horizontal bar per band, in age order, all in
 *  the first chart colour since the bands are one measurement and age is already their order. Each
 *  count links to the findings it counts, an empty band keeps its track and a linked 0, and the
 *  hidden table gives a screen reader the same numbers. */
export function AgeBandsChart({ bands }: { bands: readonly AgeBand[] }) {
  const max = Math.max(1, ...bands.map(b => b.count));
  return (
    <div>
      <ul className="space-y-2">
        {bands.map(b => (
          <li key={b.key} data-band={b.key} className="grid grid-cols-[7rem_1fr_3rem] items-center gap-3 text-sm">
            <span className="text-ink-2">{b.label}</span>
            <span className="relative h-4 bg-track">
              {b.count > 0 && (
                <span
                  data-bar={b.key}
                  className="absolute inset-y-0 left-0"
                  style={{ width: `${(b.count / max) * 100}%`, backgroundColor: 'var(--color-chart-1)' }}
                />
              )}
            </span>
            <Link href={b.href} className="numeral-grid text-right font-medium text-ink hover:underline">{b.count}</Link>
          </li>
        ))}
      </ul>
      <ChartDataTable
        caption="Open findings by age"
        labelColumn="Age"
        columns={['Open findings']}
        rows={bands.map(b => ({ label: b.label, cells: [String(b.count)] }))}
      />
    </div>
  );
}
