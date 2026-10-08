// An epoch at or above this is read as milliseconds, below it as seconds. 1e11 seconds is the year
// 5138 and 1e11 milliseconds is March 1973, so no real Deadline is ambiguous: every second-based
// epoch from 1970 to 5138 stays below it, and every millisecond-based one from 1973 on is above it.
export const EPOCH_MILLISECONDS_CUTOFF = 1e11;

// Latest instant a Deadline may be (end of year 9999), so a stray huge number is not stored as a date.
const MAX_DEADLINE_MS = 253_402_300_799_999;

const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/i;
const EPOCH_PATTERN = /^\d+(?:\.\d+)?$/;

// An epoch below this is not a plausible Deadline in seconds (1973) and a bare small number such as a
// year or a count is far more likely to be something else, so it is not read as one.
const EPOCH_FLOOR = 1e8;

function fromEpoch(n: number): string | null {
  if (!Number.isFinite(n) || n < EPOCH_FLOOR) return null;
  const ms = n >= EPOCH_MILLISECONDS_CUTOFF ? n : n * 1000;
  if (ms > MAX_DEADLINE_MS) return null;
  return new Date(ms).toISOString();
}

function fromIso(text: string): string | null {
  const m = ISO_PATTERN.exec(text);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00'] = m;
  // Date.parse accepts a day past the end of the month by rolling it over; a Deadline is never guessed.
  const probe = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  if (probe.getUTCMonth() !== Number(mo) - 1 || probe.getUTCDate() !== Number(d)) return null;
  const zone = m[7];
  const normalised = text.replace(' ', 'T') + (m[4] === undefined ? 'T00:00:00Z' : zone ? '' : 'Z');
  const ms = Date.parse(normalised);
  return Number.isNaN(ms) || ms > MAX_DEADLINE_MS ? null : new Date(ms).toISOString();
}

/**
 * The UTC ISO timestamp of a Deadline column's value, or null when it is not one. Reads an ISO 8601
 * string (a date alone or a date and time, UTC when no offset is given), an epoch number, or an
 * all-digit string holding an epoch (Advisor and Service Health return both shapes). An epoch below
 * EPOCH_MILLISECONDS_CUTOFF is seconds, at or above it milliseconds. Anything else, including a
 * loose phrase a lenient date parser would accept, is null: a rule whose Deadline column holds
 * junk still runs, its findings simply have no Deadline.
 */
export function parseDeadline(value: unknown): string | null {
  if (typeof value === 'number') return fromEpoch(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  if (EPOCH_PATTERN.test(text)) return fromEpoch(Number(text));
  return fromIso(text);
}
