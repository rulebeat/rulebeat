/**
 * How dashboard charts are painted, read from the sources that paint them: Recharts draws into SVG that
 * cannot be rendered without a browser, so the colour, height and role of a chart are held where they are
 * written. The values a chart is given are tested through the code that computes them (chart-gaps,
 * the tooltips, the summary).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHART_PLOT_HEIGHT } from '@/components/dashboard/dashboard-constants';

const root = resolve(__dirname, '../..');

function sources(dir: string): Array<{ rel: string; text: string }> {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [{ rel: relative(root, path), text: readFileSync(path, 'utf8') }] : [];
  });
}

const dashboardSources = [...sources(join(root, 'components/dashboard')), ...sources(join(root, 'app/(app)/dashboards'))];
const widget = (name: string) => readFileSync(join(root, 'components/dashboard/widgets', name), 'utf8');

describe('dashboard chart paint', () => {
  it('finds the dashboard sources it is meant to guard', () => {
    expect(dashboardSources.length).toBeGreaterThan(10);
  });

  it('uses the ok status colour nowhere in a dashboard component', () => {
    const offenders = dashboardSources.filter(f => /status-ok/.test(f.text)).map(f => f.rel);
    expect(offenders).toEqual([]);
  });

  it('wraps no chart in role="img"', () => {
    const offenders = dashboardSources.filter(f => /role=["']img["']/.test(f.text)).map(f => f.rel);
    expect(offenders).toEqual([]);
  });

  it('draws New on chart-1 and Fixed on chart-2, with nothing counting new findings in red', () => {
    const text = widget('new-vs-fixed-widget.tsx');
    expect(text).toMatch(/dataKey="created"[^>]*fill="var\(--color-chart-1\)"/);
    expect(text).toMatch(/dataKey="resolved"[^>]*fill="var\(--color-chart-2\)"/);
    expect(widget('stat-card-widget.tsx')).not.toMatch(/newInWindow[^\n]*sev-critical/);
  });

  it('gives the three time charts one fixed 220px plot height and a responsive width', () => {
    expect(CHART_PLOT_HEIGHT).toBe(220);
    for (const file of ['trend-widget.tsx', 'new-vs-fixed-widget.tsx', 'activity-occurrences-widget.tsx']) {
      const text = widget(file);
      expect(text, file).toContain('<ResponsiveContainer width="100%" height={CHART_PLOT_HEIGHT}>');
      expect(text, file).not.toMatch(/ResponsiveContainer[^>]*height="100%"/);
    }
  });
});
