import { allowedSpans, UNKNOWN_TYPE_SPANS } from './widget-sizes';

/**
 * What a dashboard Save may write. Only a write is checked: a stored row is never validated or
 * rewritten on read, so a layout saved by an older build still renders and is only held to this
 * on its next Save. Pure and free of server imports so the route and its tests share one definition.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCount = (value: unknown): boolean => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** Structural equality of two JSON values, ignoring object key order. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => sameJson(item, b[i]));
  }
  if (isRecord(a)) {
    if (!isRecord(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameJson(a[key], b[key]));
  }
  return a === b;
}

/** The stored widgets of a row, read as plain JSON, or an empty list when the stored config is not readable. */
function storedWidgets(stored: unknown): Record<string, unknown>[] {
  const widgets = isRecord(stored) ? stored.widgets : undefined;
  return Array.isArray(widgets) ? widgets.filter(isRecord) : [];
}

/**
 * The reason a dashboard config cannot be saved, or null when it can. `stored` is the config the row
 * holds now, as stored (not migrated): a widget of a type this build does not know is accepted only
 * when it is the very widget the row already holds, so a Save cannot invent one.
 */
export function dashboardConfigProblem(config: unknown, stored: unknown): string | null {
  if (!isRecord(config) || !Array.isArray(config.widgets)) return 'The dashboard config must hold a list of widgets.';
  const inRow = storedWidgets(stored);
  const ids = new Set<unknown>();
  for (const widget of config.widgets as unknown[]) {
    if (!isRecord(widget) || typeof widget.id !== 'string' || !widget.id || typeof widget.type !== 'string') {
      return 'Every widget needs an id and a type.';
    }
    if (ids.has(widget.id)) return `Two widgets share the id "${widget.id}".`;
    ids.add(widget.id);
    for (const field of ['x', 'y', 'h'] as const) {
      if (!isCount(widget[field])) return `Widget "${widget.id}" needs a whole number of 0 or more for ${field}.`;
    }
    const spans = allowedSpans(widget.type);
    if (spans) {
      if (typeof widget.w !== 'number' || !spans.includes(widget.w)) {
        return `A ${widget.type} widget can be ${spans.join(', ')} columns wide.`;
      }
      continue;
    }
    const kept = inRow.find(h => h.id === widget.id && h.type === widget.type);
    if (!kept || !sameJson(kept.config, widget.config)) return `Widget "${widget.id}" has a type this version does not know, and cannot be added or changed.`;
    if (typeof widget.w !== 'number' || !UNKNOWN_TYPE_SPANS.includes(widget.w)) {
      return `A widget of a type this version does not know can be ${UNKNOWN_TYPE_SPANS.join(' or ')} columns wide.`;
    }
  }
  return null;
}
