import type { DashboardConfig } from '@/lib/types';

// Pure data only — this file must not import from lib/db/* (it's used both by the server-only
// seeding path in lib/db/client.ts and, potentially, an API route).

export const STARTER_DASHBOARD: { name: string; description: string; config: DashboardConfig } = {
  name: 'Overview',
  description: 'Overall governance posture across all categories',
  config: {
    autoRefresh: 0,
    widgets: [
      { id: 'w1', type: 'stat-card',   title: 'Overall Posture', x: 0,  y: 0,  w: 3, h: 3, config: { metric: 'posture-pct' } },
      { id: 'w2', type: 'stat-card',   title: 'Open Findings',      x: 3,  y: 0,  w: 3, h: 3, config: { metric: 'total-findings' } },
      { id: 'w3', type: 'stat-card',   title: 'Critical Issues',    x: 6,  y: 0,  w: 3, h: 3, config: { metric: 'critical-findings' } },
      { id: 'w4', type: 'stat-card',   title: 'Healthy Categories', x: 9,  y: 0,  w: 3, h: 3, config: { metric: 'modules-healthy' } },
      { id: 'w5', type: 'trend',       title: 'Posture Trend',   x: 0,  y: 3,  w: 8, h: 5, config: { category: 'all', period: '30d', chartType: 'area', showFindings: true } },
      { id: 'w6', type: 'posture-ring', title: 'Overall Posture',x: 8,  y: 3,  w: 4, h: 5, config: { category: 'all', showDelta: true, showPolicyCounts: true } },
      { id: 'w7', type: 'category-scorecard', title: 'Category Overview', x: 0, y: 8, w: 12, h: 5, config: {} },
      { id: 'w8', type: 'top-rules', title: 'Top Violating Rules', x: 0, y: 13, w: 5, h: 7, config: { limit: 8 } },
      { id: 'w9', type: 'recent-findings', title: 'Recent Findings', x: 5, y: 13, w: 7, h: 7, config: { limit: 15 } },
      { id: 'w11', type: 'severity-breakdown', title: 'Severity Breakdown', x: 0, y: 20, w: 4, h: 6, config: {} },
      { id: 'w12', type: 'subscription-scorecard', title: 'Subscription Overview', x: 4, y: 20, w: 8, h: 6, config: {} },
      { id: 'w13', type: 'top-resources', title: 'Top Offending Resources', x: 0, y: 26, w: 6, h: 6, config: { limit: 8 } },
      { id: 'w14', type: 'coverage-freshness', title: 'Scan Coverage', x: 6, y: 26, w: 6, h: 6, config: {} },
      { id: 'w15', type: 'new-vs-fixed', title: 'New vs. Fixed', x: 0, y: 32, w: 12, h: 5, config: { period: '30d' } },
    ],
  },
};
