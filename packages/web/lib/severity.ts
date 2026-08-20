import type { Severity } from './types';

export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export function emptySeverityCounts(): Record<Severity, number> {
  return Object.fromEntries(SEVERITY_ORDER.map(s => [s, 0])) as Record<Severity, number>;
}
