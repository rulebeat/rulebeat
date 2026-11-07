/**
 * Issue #419: what a dashboard Save may write. The rules are checked through `dashboardConfigProblem`,
 * the one function the PUT calls, and the size table through `snapSpan`, which the client uses so a
 * layout it saves is one the PUT accepts.
 */
import { describe, expect, it } from 'vitest';
import { dashboardConfigProblem, sameJson } from '@/lib/dashboard-config-validation';
import { allowedSpans, snapSpan, WIDGET_SPANS } from '@/lib/widget-sizes';
import { STARTER_DASHBOARD } from '@/lib/dashboard-templates';

const widget = (over: Record<string, unknown> = {}) =>
  ({ id: 'w1', type: 'stat-card', title: 'Open', x: 0, y: 0, w: 3, h: 3, config: { metric: 'total-findings' }, ...over });
const configOf = (...widgets: unknown[]) => ({ widgets });
const NOTHING_STORED = { widgets: [] };

describe('a known widget type', () => {
  it('is accepted at each span its type allows', () => {
    for (const [type, spans] of Object.entries(WIDGET_SPANS)) {
      for (const w of spans) expect(dashboardConfigProblem(configOf(widget({ type, w })), NOTHING_STORED), `${type} at ${w}`).toBeNull();
    }
  });

  it('is refused at a span its type does not allow, and names the spans that it does', () => {
    expect(dashboardConfigProblem(configOf(widget({ type: 'stat-card', w: 5 })), NOTHING_STORED)).toBe('A stat-card widget can be 3, 4, 6 columns wide.');
    expect(dashboardConfigProblem(configOf(widget({ type: 'category-scorecard', w: 3 })), NOTHING_STORED)).toContain('6, 12');
  });

  it('is refused when w is not a number', () => {
    expect(dashboardConfigProblem(configOf(widget({ w: '3' })), NOTHING_STORED)).not.toBeNull();
    expect(dashboardConfigProblem(configOf(widget({ w: undefined })), NOTHING_STORED)).not.toBeNull();
  });

  it('holds every widget of the starter dashboard to spans its type allows', () => {
    expect(dashboardConfigProblem(STARTER_DASHBOARD.config, NOTHING_STORED)).toBeNull();
  });
});

describe('x, y and h', () => {
  it.each(['x', 'y', 'h'] as const)('refuse a %s that is negative, fractional, text or missing', (field) => {
    for (const bad of [-1, 1.5, '2', null, NaN, undefined]) {
      expect(dashboardConfigProblem(configOf(widget({ [field]: bad })), NOTHING_STORED), `${field}=${String(bad)}`).toContain(field);
    }
  });

  it.each(['x', 'y', 'h'] as const)('accept a %s of 0 and of a larger whole number', (field) => {
    expect(dashboardConfigProblem(configOf(widget({ [field]: 0 })), NOTHING_STORED)).toBeNull();
    expect(dashboardConfigProblem(configOf(widget({ [field]: 40 })), NOTHING_STORED)).toBeNull();
  });
});

describe('widget ids', () => {
  it('refuses two widgets with one id', () => {
    expect(dashboardConfigProblem(configOf(widget(), widget({ y: 3 })), NOTHING_STORED)).toBe('Two widgets share the id "w1".');
  });

  it('refuses a widget with no id or no type', () => {
    expect(dashboardConfigProblem(configOf(widget({ id: undefined })), NOTHING_STORED)).not.toBeNull();
    expect(dashboardConfigProblem(configOf(widget({ type: undefined })), NOTHING_STORED)).not.toBeNull();
    expect(dashboardConfigProblem(configOf('not a widget'), NOTHING_STORED)).not.toBeNull();
  });
});

describe('a config with no widgets', () => {
  it('is accepted', () => {
    expect(dashboardConfigProblem(configOf(), NOTHING_STORED)).toBeNull();
  });

  it('is refused when there is no list at all', () => {
    expect(dashboardConfigProblem({}, NOTHING_STORED)).not.toBeNull();
    expect(dashboardConfigProblem(null, NOTHING_STORED)).not.toBeNull();
    expect(dashboardConfigProblem({ widgets: 'none' }, NOTHING_STORED)).not.toBeNull();
  });
});

describe('a widget of a type this build does not know', () => {
  const stored = configOf(widget({ id: 'old', type: 'from-the-future', w: 6, config: { a: 1, nested: { b: [1, 2] } } }));
  const kept = (over: Record<string, unknown> = {}) => widget({ id: 'old', type: 'from-the-future', w: 6, config: { nested: { b: [1, 2] }, a: 1 }, ...over });

  it('is accepted when the row holds the same id and type, the same config (key order aside) and w is 6 or 12', () => {
    expect(dashboardConfigProblem(configOf(kept()), stored)).toBeNull();
    expect(dashboardConfigProblem(configOf(kept({ w: 12 })), stored)).toBeNull();
  });

  it('can move and change height, since only its id, type, config and w are held', () => {
    expect(dashboardConfigProblem(configOf(kept({ x: 6, y: 9, h: 7 })), stored)).toBeNull();
  });

  it('is refused when it is new', () => {
    expect(dashboardConfigProblem(configOf(kept({ id: 'new' })), stored)).toContain('cannot be added or changed');
    expect(dashboardConfigProblem(configOf(kept()), NOTHING_STORED)).toContain('cannot be added or changed');
  });

  it('is refused when its type differs from the stored widget with that id, unless the new type is one it knows', () => {
    expect(dashboardConfigProblem(configOf(kept({ type: 'another-future' })), stored)).not.toBeNull();
    expect(dashboardConfigProblem(configOf(kept({ type: 'stat-card', w: 3 })), stored)).toBeNull();
  });

  it('is refused when its config differs in any way', () => {
    expect(dashboardConfigProblem(configOf(kept({ config: { a: 2, nested: { b: [1, 2] } } })), stored)).not.toBeNull();
    expect(dashboardConfigProblem(configOf(kept({ config: { a: 1, nested: { b: [2, 1] } } })), stored)).not.toBeNull();
    expect(dashboardConfigProblem(configOf(kept({ config: { a: 1, nested: { b: [1, 2] }, extra: true } })), stored)).not.toBeNull();
    expect(dashboardConfigProblem(configOf(kept({ config: undefined })), stored)).not.toBeNull();
  });

  it('is refused at any w other than 6 or 12', () => {
    for (const w of [3, 4, 8, 11]) expect(dashboardConfigProblem(configOf(kept({ w })), stored), `w=${w}`).not.toBeNull();
  });

  it('is refused when the stored config cannot be read as a layout', () => {
    expect(dashboardConfigProblem(configOf(kept()), null)).not.toBeNull();
    expect(dashboardConfigProblem(configOf(kept()), { widgets: 'garbled' })).not.toBeNull();
  });
});

describe('sameJson', () => {
  it('ignores key order and tells arrays by order', () => {
    expect(sameJson({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })).toBe(true);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
    expect(sameJson({ a: undefined }, {})).toBe(false);
    expect(sameJson({}, [])).toBe(false);
  });
});

describe('the size table', () => {
  it('snaps to the nearest allowed span, a tie going to the smaller', () => {
    expect(snapSpan('stat-card', 5)).toBe(4);   // 4 and 6 are both one away
    expect(snapSpan('stat-card', 1)).toBe(3);
    expect(snapSpan('stat-card', 12)).toBe(6);
    expect(snapSpan('trend', 7)).toBe(6);       // 6 and 8: the smaller
    expect(snapSpan('trend', 11)).toBe(12);
  });

  it('snaps a type it does not know within 6 and 12', () => {
    expect(snapSpan('from-the-future', 3)).toBe(6);
    expect(snapSpan('from-the-future', 9)).toBe(6);
    expect(snapSpan('from-the-future', 10)).toBe(12);
  });

  it('gives a snapped span the PUT accepts', () => {
    for (const type of [...Object.keys(WIDGET_SPANS), 'from-the-future']) {
      for (let w = 1; w <= 12; w++) {
        expect((allowedSpans(type) ?? [6, 12]).includes(snapSpan(type, w)), `${type} ${w}`).toBe(true);
      }
    }
  });

  it('knows no inherited property as a type', () => {
    expect(allowedSpans('constructor')).toBeNull();
    expect(allowedSpans('__proto__')).toBeNull();
  });
});
