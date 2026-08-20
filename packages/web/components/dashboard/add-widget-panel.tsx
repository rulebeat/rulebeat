'use client';

import { SlideOverPanel } from '@/components/dashboard/slide-over-panel';
import type { WidgetType, WidgetDef } from '@/lib/types';

interface WidgetTemplate {
  type: WidgetType;
  title: string;
  description: string;
  defaultConfig: Record<string, unknown>;
  defaultW: number;
  defaultH: number;
}

const WIDGET_TEMPLATES: WidgetTemplate[] = [
  {
    type: 'stat-card',
    title: 'Stat Card',
    description: 'Single metric: posture %, finding counts, healthy modules.',
    defaultConfig: { metric: 'posture-pct' },
    defaultW: 3, defaultH: 3,
  },
  {
    type: 'posture-ring',
    title: 'Posture Ring',
    description: 'Circular posture % gauge for a category or overall.',
    defaultConfig: { category: 'all', showDelta: true, showPolicyCounts: true },
    defaultW: 4, defaultH: 5,
  },
  {
    type: 'trend',
    title: 'Trend Chart',
    description: 'Area, line, or bar chart showing posture % over time.',
    defaultConfig: { category: 'all', period: '30d', chartType: 'area', showFindings: true },
    defaultW: 8, defaultH: 5,
  },
  {
    type: 'top-rules',
    title: 'Top Violating Rules',
    description: 'Horizontal bar chart of rules with the most violations.',
    defaultConfig: { limit: 8 },
    defaultW: 5, defaultH: 7,
  },
  {
    type: 'category-scorecard',
    title: 'Category Scorecard',
    description: 'Grid view showing posture % and findings for every category.',
    defaultConfig: {},
    defaultW: 12, defaultH: 5,
  },
  {
    type: 'recent-findings',
    title: 'Recent Findings',
    description: 'Compact feed of the newest findings. Click a row to open it in Scans.',
    defaultConfig: { limit: 10 },
    defaultW: 7, defaultH: 7,
  },
  {
    type: 'severity-breakdown',
    title: 'Severity Breakdown',
    description: 'Donut chart of open findings by severity.',
    defaultConfig: {},
    defaultW: 4, defaultH: 6,
  },
  {
    type: 'subscription-scorecard',
    title: 'Subscription Scorecard',
    description: 'Grid view showing posture % and findings for every subscription.',
    defaultConfig: {},
    defaultW: 8, defaultH: 6,
  },
  {
    type: 'top-resources',
    title: 'Top Offending Resources',
    description: 'Resources with the most open findings.',
    defaultConfig: { limit: 8 },
    defaultW: 6, defaultH: 6,
  },
  {
    type: 'coverage-freshness',
    title: 'Scan Coverage',
    description: 'Last scan time per category, with a staleness warning.',
    defaultConfig: {},
    defaultW: 6, defaultH: 6,
  },
  {
    type: 'new-vs-fixed',
    title: 'New vs. Fixed',
    description: 'Remediation velocity: findings created vs. resolved over time.',
    defaultConfig: { period: '30d' },
    defaultW: 12, defaultH: 5,
  },
  {
    type: 'activity-occurrences',
    title: 'Activity Occurrences',
    description: 'How often activity-pattern findings (sign-in risk, audit events) keep recurring.',
    defaultConfig: { period: '30d' },
    defaultW: 12, defaultH: 5,
  },
];

interface Props {
  onAdd: (widget: Omit<WidgetDef, 'id' | 'x' | 'y'>) => void;
  onClose: () => void;
}

export function AddWidgetPanel({ onAdd, onClose }: Props) {
  return (
    <SlideOverPanel title="Add Widget" onClose={onClose}>
      {WIDGET_TEMPLATES.map(t => (
        <button
          key={t.type}
          onClick={() => {
            onAdd({ type: t.type, title: t.title, w: t.defaultW, h: t.defaultH, config: t.defaultConfig });
            onClose();
          }}
          className="group w-full border border-border p-3 text-left transition-colors hover:border-ink hover:bg-surface-hover"
        >
          <p className="text-sm font-semibold text-ink">{t.title}</p>
          <p className="mt-0.5 text-xs text-ink-2">{t.description}</p>
        </button>
      ))}
    </SlideOverPanel>
  );
}
