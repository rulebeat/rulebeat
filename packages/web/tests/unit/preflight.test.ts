/**
 * B3 phase 2 · lib/preflight.ts
 *
 * The whole point of this module is that its output is safe to show a browser — an ARG or Graph
 * failure carries the tenant id, subscription ids and correlation ids, none of which belong in a
 * response an admin might screenshot. Every scenario below that exercises a failure path also
 * asserts the raw error text is nowhere in the serialised result, not just that the status is right.
 *
 * `fakeTenantContext()`'s credential deliberately throws if used for real (see tests/helpers/
 * fake-azure.ts), so `getToken`/`fetchImpl` are always injected here rather than left to the
 * defaults — this suite makes zero live Azure or Graph calls.
 */
import { describe, expect, it, vi } from 'vitest';
import { fakeTenantContext } from '../helpers/fake-azure';
import { runPreflight } from '@/lib/preflight';
import { NO_SUBSCRIPTIONS_MESSAGE } from '@/lib/azure-credential';

function okFetch(status = 200): typeof fetch {
  return vi.fn(async () => new Response('{}', { status })) as unknown as typeof fetch;
}

describe('B3 · runPreflight', () => {
  it('every check passes when the identity is fully set up', async () => {
    const ctx = fakeTenantContext({
      subscriptionIds: ['sub-a', 'sub-b'],
      rows: [
        { subscriptionId: 'sub-a', name: 'Sub A' },
        { subscriptionId: 'sub-b', name: 'Sub B' },
      ],
      logsRows: [],
    });
    const getToken = vi.fn(async () => 'fake-token');

    const result = await runPreflight({ ctx, getToken, fetchImpl: okFetch(), clientId: 'client-1' });

    expect(result.overall).toBe('ok');
    expect(result.checks.map(c => c.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(result.subscriptions).toEqual([
      { id: 'sub-a', name: 'Sub A' },
      { id: 'sub-b', name: 'Sub B' },
    ]);
  });

  describe('log-analytics check (spec 038: paused, must not appear)', () => {
    it('never appears when no workspace is configured — the default fake context', async () => {
      const ctx = fakeTenantContext({ subscriptionIds: ['sub-a'], rows: [{ subscriptionId: 'sub-a', name: 'Sub A' }] });
      const getToken = vi.fn(async () => 'fake-token');

      const result = await runPreflight({ ctx, getToken, includeGraph: false });

      expect(result.checks.find(c => c.id === 'log-analytics')).toBeUndefined();
      expect(result.overall).toBe('ok');
    });

    it('never appears even when a workspace is configured and answers a query', async () => {
      const ctx = fakeTenantContext({
        subscriptionIds: ['sub-a'],
        rows: [{ subscriptionId: 'sub-a', name: 'Sub A' }],
        logsRows: [{ Column1: 1 }],
      });
      const getToken = vi.fn(async () => 'fake-token');

      const result = await runPreflight({ ctx, getToken, includeGraph: false });

      expect(result.checks.find(c => c.id === 'log-analytics')).toBeUndefined();
      // Confirms checkLogAnalytics() itself was never invoked, not just filtered out afterward.
      expect(ctx.logsQueries).toEqual([]);
    });

    it('never appears, and never surfaces its error, even when the underlying query would fail', async () => {
      const sensitive = '33333333-3333-3333-3333-333333333333';
      const ctx = fakeTenantContext({
        subscriptionIds: ['sub-a'],
        rows: [{ subscriptionId: 'sub-a', name: 'Sub A' }],
        logsFailWith: new Error(`Log Analytics error for workspace ${sensitive}, correlationId eeee-ffff`),
      });
      const getToken = vi.fn(async () => 'fake-token');

      const result = await runPreflight({ ctx, getToken, includeGraph: false });

      expect(result.checks.find(c => c.id === 'log-analytics')).toBeUndefined();
      expect(result.overall).toBe('ok');
      expect(JSON.stringify(result)).not.toContain(sensitive);
    });
  });

  it('a credential failure reports a curated message, never the raw error text', async () => {
    const ctx = fakeTenantContext();
    const sensitive = '11111111-1111-1111-1111-111111111111';
    const getToken = vi.fn(async () => {
      throw new Error(`AADSTS7000215: Invalid client secret for tenant ${sensitive}, correlation id aaaa-bbbb`);
    });

    const result = await runPreflight({ ctx, getToken, fetchImpl: okFetch(), includeGraph: false });

    const check = result.checks.find(c => c.id === 'credential')!;
    expect(check.status).toBe('fail');
    expect(result.overall).toBe('fail');
    expect(JSON.stringify(result)).not.toContain(sensitive);
  });

  it('zero subscriptions is a fail using the exact verifyAzureCredential wording', async () => {
    const ctx = fakeTenantContext({ subscriptionIds: [] });
    const getToken = vi.fn(async () => 'fake-token');

    const result = await runPreflight({ ctx, getToken, includeGraph: false });

    const check = result.checks.find(c => c.id === 'subscriptions')!;
    expect(check.status).toBe('fail');
    expect(check.summary).toBe(NO_SUBSCRIPTIONS_MESSAGE);
    expect(result.overall).toBe('fail');
  });

  it('subscriptions come straight from ctx.subscriptionIds, no second live call', async () => {
    // Reading ctx.subscriptionIds (already resolved by createTenantContext) rather than calling
    // listAccessibleSubscriptions() again is what makes this check reachable through the fake
    // context at all — its credential throws if anything tries to use it for a real Azure SDK call.
    const ctx = fakeTenantContext({ subscriptionIds: ['sub-a'] });
    const getToken = vi.fn(async () => 'fake-token');

    const result = await runPreflight({ ctx, getToken, includeGraph: false });

    expect(result.checks.find(c => c.id === 'subscriptions')!.status).toBe('ok');
  });

  it('a resource-graph count mismatch against the subscriptions check warns, not fails', async () => {
    const ctx = fakeTenantContext({
      subscriptionIds: ['sub-a', 'sub-b'],
      rows: [{ subscriptionId: 'sub-a', name: 'Sub A' }], // only one of the two accessible subs
    });
    const getToken = vi.fn(async () => 'fake-token');

    const result = await runPreflight({ ctx, getToken, includeGraph: false });

    const check = result.checks.find(c => c.id === 'resource-graph')!;
    expect(check.status).toBe('warn');
    expect(result.overall).toBe('warn');
  });

  it('a resource-graph error is a client-safe summary, never String(err)', async () => {
    const sensitive = '22222222-2222-2222-2222-222222222222';
    const ctx = fakeTenantContext({
      failWith: new Error(`Resource Graph error for tenant ${sensitive}, correlationId cccc-dddd`),
    });
    const getToken = vi.fn(async () => 'fake-token');

    const result = await runPreflight({ ctx, getToken, includeGraph: false });

    const check = result.checks.find(c => c.id === 'resource-graph')!;
    expect(check.status).toBe('fail');
    expect(JSON.stringify(result)).not.toContain(sensitive);
  });

  it('Microsoft Graph 403 warns rather than fails — directory rules are one backend among several', async () => {
    const ctx = fakeTenantContext({ subscriptionIds: ['sub-a'], rows: [{ subscriptionId: 'sub-a', name: 'Sub A' }] });
    const getToken = vi.fn(async () => 'fake-token');

    const result = await runPreflight({ ctx, getToken, fetchImpl: okFetch(403), clientId: 'client-1' });

    const check = result.checks.find(c => c.id === 'graph-applications')!;
    expect(check.status).toBe('warn');
    expect(check.remediation).toContain('client-1');
    // Nothing else in this scenario fails, so the only degradation is the warn above.
    expect(result.overall).toBe('warn');
  });

  it('includeGraph: false skips the check and never calls fetchImpl', async () => {
    const ctx = fakeTenantContext();
    const getToken = vi.fn(async () => 'fake-token');
    const fetchImpl = okFetch() as ReturnType<typeof vi.fn>;

    const result = await runPreflight({ ctx, getToken, fetchImpl: fetchImpl as unknown as typeof fetch, includeGraph: false });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.checks.find(c => c.id === 'graph-applications')!.status).toBe('skipped');
  });
});
