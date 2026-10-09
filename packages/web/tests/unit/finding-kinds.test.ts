/**
 * Two predicates. countsTowardPosture answers a rule-level question: can this rule be scored on
 * a zero-findings-is-passing basis. Only a state-kind rule can; the posture denominator, the
 * rule split in the snapshot writer, and a rule-scoped widget's own pct all use it.
 *
 * countsInFindingTotals answers a finding-level question: does this finding belong in a
 * finding-level total (the Results tiles, recent findings, top rules, top resources, the
 * dashboard stat cards, New vs Fixed, the snapshot writer's severity counts). Only state
 * findings count, the same as posture, written positively as "kind is state" so a future kind is
 * excluded the moment it exists, not once every call site is updated for it.
 *
 * lib/finding-kinds.ts must stay free of drizzle/db imports: lib/explorer-filters.ts imports it
 * and is itself imported by a 'use client' component, so anything it pulls in is bundled for the
 * browser.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countsTowardPosture, countsInFindingTotals } from '@/lib/finding-kinds';
import type { RuleKind } from '@/lib/types';

const FUTURE_KIND = 'advisory' as unknown as RuleKind;

describe('countsTowardPosture', () => {
  it('a state-kind object counts', () => {
    expect(countsTowardPosture({ kind: 'state' })).toBe(true);
  });

  it('an activity-kind object does not count', () => {
    expect(countsTowardPosture({ kind: 'activity' })).toBe(false);
  });

  it('an absent kind defaults to state and counts, same convention as the SQL layer default', () => {
    expect(countsTowardPosture({})).toBe(true);
  });

  it('a future kind that is not literally "state" does not count, without needing its own branch', () => {
    // Stands in for a kind that doesn't exist yet (e.g. 'advisory', ADR 0005). The predicate
    // must already exclude it today, by construction, not just once someone remembers to add a
    // check for it.
    expect(countsTowardPosture({ kind: FUTURE_KIND })).toBe(false);
  });
});

describe('countsInFindingTotals', () => {
  it('a state-kind object counts', () => {
    expect(countsInFindingTotals({ kind: 'state' })).toBe(true);
  });

  it('an activity-kind object does not count, the same as countsTowardPosture', () => {
    expect(countsInFindingTotals({ kind: 'activity' })).toBe(false);
  });

  it('an absent kind defaults to state and counts', () => {
    expect(countsInFindingTotals({})).toBe(true);
  });

  it('a future kind that is not literally "state" does not count, without needing its own branch', () => {
    expect(countsInFindingTotals({ kind: FUTURE_KIND })).toBe(false);
  });
});

describe('lib/finding-kinds.ts stays client-safe', () => {
  it('has no import from drizzle or a lib/db module', () => {
    const modulePath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'finding-kinds.ts');
    const source = readFileSync(modulePath, 'utf8');
    const importsDrizzle = /from\s+['"]drizzle-orm['"]/.test(source);
    const importsDb = /from\s+['"][^'"]*\/db\//.test(source);
    expect(importsDrizzle || importsDb, 'lib/finding-kinds.ts is imported by a client component (via lib/explorer-filters.ts) and must not pull in drizzle or lib/db').toBe(false);
  });
});
