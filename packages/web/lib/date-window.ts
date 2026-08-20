/** Shared window/date-range concept for both Dashboards and Scans. A window is either a rolling
 *  "last N days" (always relative to whenever it's resolved — a saved dashboard's "7d" preset
 *  still means "the last 7 days" when reopened next month) or a fixed calendar range with
 *  explicit dates. Client-safe (no Node deps) — used server-side to resolve concrete dates before
 *  querying, and client-side for default state and display labels. */
export type DateWindow =
  | { mode: 'relative'; days: number }
  | { mode: 'custom'; from: string; to: string }; // ISO date (YYYY-MM-DD)

export function todayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function daysAgoKey(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Resolves a DateWindow into concrete `[from, to]` date-key bounds (inclusive). Custom ranges
 *  are clamped: `to` can never be in the future (no data exists there), and `from` can never be
 *  after `to`. */
export function resolveDateWindow(w: DateWindow, now: Date = new Date()): { from: string; to: string } {
  const today = todayKey(now);
  if (w.mode === 'custom') {
    const to = w.to > today ? today : w.to;
    const from = w.from > to ? to : w.from;
    return { from, to };
  }
  return { from: daysAgoKey(w.days, now), to: today };
}

const RELATIVE_LABELS: Record<number, string> = { 1: '24h', 7: '7d', 30: '30d' };

function formatDateKey(dateKey: string): string {
  // Parse as UTC to avoid the browser's local timezone shifting a YYYY-MM-DD date by a day.
  const d = new Date(`${dateKey}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Human label for display — relative windows use the familiar "24h"/"7d"/"30d" short form
 *  (falling back to "{N}d" for any other day count); custom ranges always show the real picked
 *  dates, never a vague placeholder. */
export function dateWindowLabel(w: DateWindow): string {
  if (w.mode === 'relative') return RELATIVE_LABELS[w.days] ?? `${w.days}d`;
  return `${formatDateKey(w.from)} – ${formatDateKey(w.to)}`;
}

/** Grammatical phrase for embedding a window in a sentence ("43 fixed in the last 7d" /
 *  "43 fixed during Jul 1 – Jul 11") — a bare "last {label}" reads wrong for custom ranges,
 *  where the label already IS the dates. */
export function dateWindowPhrase(w: DateWindow): string {
  const label = dateWindowLabel(w);
  return w.mode === 'relative' ? `in the last ${label}` : `during ${label}`;
}
