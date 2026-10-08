/**
 * The group a Group column's value names, or null when there is none. A string is trimmed; a number
 * or boolean is read as its text (a retirement feature id can be numeric); null, undefined, a blank
 * string, and anything structured (an object or array, which has no readable name) are no group.
 */
export function parseGroupValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return String(value);
  return null;
}
