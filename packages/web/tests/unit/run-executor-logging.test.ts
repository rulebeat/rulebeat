/**
 * Spec 006 — proves await createTenantContext({ runId }) is actually wired at run-executor.ts's one
 * production call site, not just that the plumbing compiles. '@/lib/azure-credential' is mocked so
 * no real Azure/network call happens (CLAUDE.md: no live Azure calls in tests), but the mock still
 * calls the real createScanLogger() from '@/lib/server-logger' — so a captured console.log line
 * proves the runId genuinely flows from await executeTarget() through await createTenantContext() into the
 * logger, not merely that a mock recorded an argument.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db/client';
import { rules as rulesTable } from '@/lib/db/schema';
import { resetDb, clearRules } from '../helpers/db';
import { createScanLogger } from '@/lib/server-logger';

vi.mock('@/lib/azure-credential', () => ({
  createTenantContext: async (logContext?: { runId?: string }) => ({
    tenantId: 'test-tenant',
    subscriptionIds: ['sub-1'],
    credential: {},
    log: createScanLogger(logContext),
    async queryARG() {
      return [];
    },
  }),
}));

const { executeTarget } = await import('@/lib/run-executor');

function insertRule(id: string): void {
  db.insert(rulesTable).values({
    id,
    name: id,
    description: 'test rule',
    category: 'security',
    severity: 'medium',
    enabled: true,
    scope: JSON.stringify({ level: 'subscription' }),
    resourceTypes: JSON.stringify([]),
    conditions: JSON.stringify([]),
    rawKql: 'resources | where type == "microsoft.compute/virtualmachines"',
    type: 'custom',
  }).run();
}

describe('await executeTarget() wires runId into the production scan logger (spec 006)', () => {
  beforeEach(async () => {
    await resetDb();
    await clearRules();
    insertRule('test-rule-logging');
  });

  it('a captured console.log line carries the run\'s own id', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const run = await executeTarget(
      { targetType: 'categories', targetValues: ['security'] },
      { triggeredBy: 'manual' },
    );

    const parsedLines = logSpy.mock.calls
      .map(call => call[0] as string)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter((line): line is Record<string, unknown> => line !== null);

    expect(parsedLines.length).toBeGreaterThan(0);
    expect(parsedLines.every(line => line['runId'] === run.id)).toBe(true);

    logSpy.mockRestore();
  });
});
