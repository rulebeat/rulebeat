/**
 * Run now in a running Demo scans the synthetic tenant the Demo was generated from
 * (lib/demo/live-context.ts). A rule the Demo ships gets its rows; any other query (a new rule, or a
 * shipped one a Visitor edited) fails that one rule with a reason that says it is the Demo, not
 * Azure, that has nothing to answer with.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { runRules, type Rule, type TenantContext } from '@rulebeat/core';
import { BUILTIN_RULES } from '@/lib/builtin-rules';
import { db } from '@/lib/db/client';
import { deleteMeta } from '@/lib/db/meta';
import { run as execRun } from '@/lib/db/exec';
import { rules as rulesTable } from '@/lib/db/tables';
import { resetDemoModeCacheForTests, stampDemoDatabase } from '@/lib/demo';
import { CORE_RULE_IDS } from '@/lib/demo/core-fixtures';
import { createLiveDemoContext, resetLiveDemoContextForTests } from '@/lib/demo/live-context';
import { DEMO_UNANSWERED_RULE_REASON, unansweredDemoQueries } from '@/lib/demo/unanswered';
import { executeTarget } from '@/lib/run-executor';
import { createScanContext } from '@/lib/scan-context';
import { clearRules, resetDb } from '../helpers/db';
import { fakeTenantContext } from '../helpers/fake-azure';

const PACKS_DIR = join(resolve(__dirname, '..', '..'), 'data', 'packs');

const shipped = BUILTIN_RULES.find(r =>
  CORE_RULE_IDS.includes(r.id) && r.rawKql && (r.queryBackend ?? 'resource-graph') === 'resource-graph')!;

async function outcomes(rules: Rule[], ctx: ReturnType<typeof createLiveDemoContext>) {
  const out: { ruleId: string; status: string }[] = [];
  for await (const event of runRules(rules, ctx)) {
    if (event.kind === 'outcome') out.push({ ruleId: event.outcome.ruleId, status: event.outcome.status });
  }
  return out;
}

afterEach(() => {
  resetLiveDemoContextForTests();
});

describe('createLiveDemoContext()', () => {
  it('answers a rule the Demo ships, as shipped', async () => {
    const ctx = createLiveDemoContext({ packsDir: PACKS_DIR });
    expect(await outcomes([shipped], ctx)).toEqual([{ ruleId: shipped.id, status: 'success' }]);
    expect(ctx.unansweredQueries()).toBe(0);
  });

  it('fails an edited rule with the Demo reason, and still answers the rest of the scan', async () => {
    const ctx = createLiveDemoContext({ packsDir: PACKS_DIR });
    const edited: Rule = { ...shipped, id: 'visitor-edit', rawKql: `${shipped.rawKql}\n| where name != 'x'` };

    expect(await outcomes([edited, shipped], ctx)).toEqual([
      { ruleId: 'visitor-edit', status: 'failed' },
      { ruleId: shipped.id, status: 'success' },
    ]);
    expect(ctx.unansweredQueries()).toBe(1);
    expect(ctx.logs.some(l => l.includes(DEMO_UNANSWERED_RULE_REASON))).toBe(true);
  });

  it('counts nothing for a context that is not a Demo', () => {
    expect(unansweredDemoQueries({} as TenantContext)).toBe(0);
  });
});

describe('Run now in a Demo', () => {
  beforeEach(async () => {
    await resetDb();
    await clearRules();
  });

  const priorRecording = process.env.RULEBEAT_DEMO_RECORDING;

  afterEach(async () => {
    delete process.env.RULEBEAT_DEMO;
    if (priorRecording === undefined) delete process.env.RULEBEAT_DEMO_RECORDING;
    else process.env.RULEBEAT_DEMO_RECORDING = priorRecording;
    await deleteMeta('demo-mode-v2');
    resetDemoModeCacheForTests();
  });

  async function insertVisitorRule(): Promise<void> {
    await execRun(db.insert(rulesTable).values({
      id: 'visitor-rule',
      name: 'visitor rule',
      description: 'written in the Demo',
      category: 'security',
      severity: 'medium',
      enabled: true,
      scope: JSON.stringify({ level: 'subscription' }),
      resourceTypes: JSON.stringify([]),
      conditions: JSON.stringify([]),
      rawKql: `resources | where type == "microsoft.compute/virtualmachines" | where name == 'mine'`,
      type: 'custom',
    }));
  }

  it('scans the synthetic tenant rather than Azure', async () => {
    process.env.RULEBEAT_DEMO = '1';
    await stampDemoDatabase();
    resetDemoModeCacheForTests();

    const ctx = await createScanContext();
    expect(typeof (ctx as { unansweredQueries?: unknown }).unansweredQueries).toBe('function');
  });

  it('tells the Visitor why a new rule did not run', async () => {
    await insertVisitorRule();

    const run = await executeTarget(
      { targetType: 'categories', targetValues: ['security'] },
      { triggeredBy: 'manual', ctx: createLiveDemoContext({ packsDir: PACKS_DIR }) },
    );

    expect(run.status).toBe('partial');
    expect(run.error).toBe(`security: one or more rules did not run. ${DEMO_UNANSWERED_RULE_REASON}`);
  });

  it('shows a recording what a real install shows for the same partial run, without naming the Demo', async () => {
    process.env.RULEBEAT_DEMO_RECORDING = '1';
    await insertVisitorRule();

    const run = await executeTarget(
      { targetType: 'categories', targetValues: ['security'] },
      { triggeredBy: 'manual', ctx: createLiveDemoContext({ packsDir: PACKS_DIR }) },
    );

    // A real install whose rules all fail to run produces the same partial run, so the expected
    // message is whatever the product says there, not a copy of its wording.
    const realInstall = await executeTarget(
      { targetType: 'categories', targetValues: ['security'] },
      { triggeredBy: 'manual', ctx: fakeTenantContext({ failWith: new Error('boom') }) },
    );

    expect(run.status).toBe('partial');
    // Both are a message, so the equality below cannot pass on two nulls or two empty strings.
    expect(run.error).toEqual(expect.any(String));
    expect(run.error).not.toBe('');
    expect(run.error).toBe(realInstall.error);
    expect(run.error).not.toContain('Demo');
  });
});
