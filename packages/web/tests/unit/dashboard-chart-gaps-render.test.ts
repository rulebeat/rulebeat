import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { NewVsFixedTooltip, describeDay } from '@/components/dashboard/widgets/new-vs-fixed-widget';
import { OccurrencesTooltip } from '@/components/dashboard/widgets/activity-occurrences-widget';
import { TrendTooltip, describeTrendPoint } from '@/components/dashboard/widgets/trend-widget';
import { ChartDataTable } from '@/components/dashboard/chart-data-table';
import { countRows, trendRows } from '@/lib/chart-gaps';

const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

describe('new vs. fixed tooltip', () => {
  const rows = countRows(
    [{ date: '2026-03-01', created: 0, resolved: 0 }, { date: '2026-03-02', created: 0, resolved: 0 }, { date: '2026-03-03', created: 4, resolved: 2 }],
    ['created', 'resolved'],
    ['2026-03-01'],
  );

  it('says "0 new, 0 fixed" for a recorded day with nothing in it', () => {
    expect(text(renderToStaticMarkup(createElement(NewVsFixedTooltip, { active: true, label: '2026-03-01', rows })))).toBe('2026-03-01 0 new, 0 fixed');
  });

  it('gives the reason for a day with no record instead of zeros', () => {
    expect(text(renderToStaticMarkup(createElement(NewVsFixedTooltip, { active: true, label: '2026-03-02', rows })))).toBe('2026-03-02 No record for this day');
  });

  it('counts a day with findings as recorded whatever the record says', () => {
    expect(describeDay(rows[2]!)).toBe('4 new, 2 fixed');
  });

  it('shows nothing when no day is hovered', () => {
    expect(renderToStaticMarkup(createElement(NewVsFixedTooltip, { active: false, label: '2026-03-01', rows }))).toBe('');
  });
});

describe('activity occurrences tooltip', () => {
  const rows = countRows([{ date: '2026-03-01', count: 1 }, { date: '2026-03-02', count: 0 }], ['count'], ['2026-03-01']);
  it('pluralises a recorded day and explains a gap', () => {
    expect(text(renderToStaticMarkup(createElement(OccurrencesTooltip, { active: true, label: '2026-03-01', rows })))).toBe('2026-03-01 1 occurrence');
    expect(text(renderToStaticMarkup(createElement(OccurrencesTooltip, { active: true, label: '2026-03-02', rows })))).toBe('2026-03-02 No record for this day');
  });
});

describe('posture trend tooltip and table', () => {
  const rows = trendRows(['2026-03-01', '2026-03-02', '2026-03-03'], {
    pct: [
      { date: '2026-03-01', pct: 0, passing: 0, total: 8 },
      { date: '2026-03-03', pct: 50, passing: 4, total: 8, earlierFormula: true },
    ],
  });
  const series = [{ key: 'pct', name: 'Security %', color: 'c', legendColor: 'c' }];

  it('reports a recorded zero as 0, with the counts behind it', () => {
    expect(describeTrendPoint(rows[0]!, 'pct')).toBe('0/8 passing (0%)');
  });

  it('names each kind of gap in the tooltip', () => {
    const tip = (label: string) => text(renderToStaticMarkup(createElement(TrendTooltip, { active: true, label, rows, series })));
    expect(tip('2026-03-02')).toBe('2026-03-02 Security %: No record for this day');
    expect(tip('2026-03-03')).toBe('2026-03-03 Security %: Recorded under an earlier posture formula');
  });

  it('gives the hidden table a dated row per day with the same reasons', () => {
    const html = renderToStaticMarkup(createElement(ChartDataTable, {
      caption: 'Posture trend by day',
      columns: ['Security %'],
      rows: rows.map(r => ({ label: r.date as string, cells: [describeTrendPoint(r, 'pct')] })),
    }));
    expect(html).toContain('class="sr-only"');
    expect(text(html)).toBe(
      'Posture trend by day Date Security % 2026-03-01 0/8 passing (0%) 2026-03-02 No record for this day 2026-03-03 Recorded under an earlier posture formula',
    );
  });
});
