import { describe, expect, it } from 'vitest';
import { migrateDashboardConfig } from '@/lib/dashboard-migrations';
import type { DashboardConfig, WidgetDef } from '@/lib/types';

function widget(overrides: Partial<WidgetDef> & Pick<WidgetDef, 'id' | 'type'>): WidgetDef {
  return { title: '', x: 0, y: 0, w: 1, h: 1, config: {}, ...overrides };
}

function configOf(...widgets: WidgetDef[]): DashboardConfig {
  return { widgets };
}

describe('migrateDashboardConfig', () => {
  it('rewrites a legacy top-policies widget to top-rules, config unchanged', async () => {
    const before = configOf(widget({ id: 'w1', type: 'top-policies' as WidgetDef['type'], config: { limit: 8 } }));
    const after = migrateDashboardConfig(before);
    expect(after.widgets[0]!.type).toBe('top-rules');
    expect(after.widgets[0]!.config).toEqual({ limit: 8 });
  });

  it('rewrites a legacy policies-scanned stat metric to rules-scanned', async () => {
    const before = configOf(widget({ id: 'w1', type: 'stat-card', config: { metric: 'policies-scanned' } }));
    const after = migrateDashboardConfig(before);
    expect(after.widgets[0]!.config.metric).toBe('rules-scanned');
  });

  it('is idempotent — a config with nothing to migrate passes through unchanged', async () => {
    const before = configOf(
      widget({ id: 'w1', type: 'top-rules', config: { limit: 8 } }),
      widget({ id: 'w2', type: 'stat-card', config: { metric: 'rules-scanned' } }),
    );
    const after = migrateDashboardConfig(before);
    expect(after).toEqual(before);
  });

  it('leaves widgets untouched by any mapping as-is', async () => {
    const before = configOf(widget({ id: 'w1', type: 'severity-breakdown', config: { category: 'cost' } }));
    const after = migrateDashboardConfig(before);
    expect(after.widgets[0]).toEqual(before.widgets[0]);
  });
});
