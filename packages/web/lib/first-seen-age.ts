/**
 * The rolling first-seen filter's value: how old a finding is, in whole UTC days, from the day it was
 * first seen to the day the request is made. Written `<min>-<max>`, both ends inclusive and either one
 * optional: `8-30` is "8 to 30 days ago", `91-` is "more than 90 days ago", `-7` is "up to 7 days ago".
 * A value holds no date, so a link keeps rolling: it is resolved against the clock of each request.
 * Client-safe: no Node, no framework imports.
 */
import { todayKey } from './date-window';

export interface FirstSeenAge { min?: number; max?: number }

const AGE = /^(\d{1,5})?-(\d{1,5})?$/;
const DAY_MS = 86_400_000;

/** The bounds a value holds, or null when it is none: no bound at all, or a lower one above the upper. */
export function parseFirstSeenAge(value: string): FirstSeenAge | null {
  const match = AGE.exec(value);
  if (!match || (match[1] === undefined && match[2] === undefined)) return null;
  const min = match[1] === undefined ? undefined : Number(match[1]);
  const max = match[2] === undefined ? undefined : Number(match[2]);
  if (min !== undefined && max !== undefined && min > max) return null;
  return { ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
}

/** A finding's age in whole UTC days on the day of `now`. One first seen after today (a skewed clock)
 *  is 0 days old. */
export function ageInDays(firstSeenAt: string, now: Date): number {
  const elapsed = Date.parse(`${todayKey(now)}T00:00:00Z`) - Date.parse(`${firstSeenAt.slice(0, 10)}T00:00:00Z`);
  return Math.max(0, elapsed / DAY_MS);
}

/** Whether a finding first seen at `firstSeenAt` falls in any of the ranges. No range accepts nothing. */
export function matchesFirstSeenAge(firstSeenAt: string, ranges: readonly FirstSeenAge[], now: Date): boolean {
  const age = ageInDays(firstSeenAt, now);
  return ranges.some(r => (r.min === undefined || age >= r.min) && (r.max === undefined || age <= r.max));
}

const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

/** What a chip says of a value. */
export function firstSeenAgeLabel(value: string): string {
  const age = parseFirstSeenAge(value);
  if (!age) return value;
  const { min, max } = age;
  if (min !== undefined && max !== undefined) {
    if (min === 0 && max === 0) return 'today';
    return min === max ? `${days(min)} ago` : `${min} to ${days(max)} ago`;
  }
  if (min !== undefined) return min > 1 ? `more than ${days(min - 1)} ago` : `${min} or more days ago`;
  return `up to ${days(max!)} ago`;
}
