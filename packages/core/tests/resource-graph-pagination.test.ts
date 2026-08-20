/**
 * Codex review Phase 5, item 5: Resource Graph pagination and truncation at the transport boundary.
 *
 * `resource-graph-scope.test.ts` covers spec 004's request-shape rules (batching, the
 * subscriptions/managementGroups conflict, the timeout argument) but every one of its mocked
 * responses is a single untruncated page — `ResourceGraphClient.queryBatch()`'s own skipToken loop
 * and its `resultTruncated: 'true'` → `ResourceGraphTruncatedError` path had no test at all. Same
 * mock-at-the-SDK-boundary pattern as that file.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenCredential } from '@azure/identity';

const { resourcesMock } = vi.hoisted(() => ({ resourcesMock: vi.fn() }));

vi.mock('@azure/arm-resourcegraph', () => ({
  ResourceGraphClient: vi.fn().mockImplementation(function (this: unknown) {
    return { resources: resourcesMock };
  }),
}));

const { ResourceGraphClient, ResourceGraphTruncatedError } = await import('../src/clients/resource-graph.js');

const FAKE_CREDENTIAL = {} as TokenCredential;

beforeEach(() => {
  resourcesMock.mockReset();
});

describe('ResourceGraphClient — skipToken pagination', () => {
  it('follows skipToken across multiple pages and yields every row from all of them', async () => {
    resourcesMock
      .mockResolvedValueOnce({ data: [{ id: 'r1' }, { id: 'r2' }], skipToken: 'page-2', resultTruncated: 'false' })
      .mockResolvedValueOnce({ data: [{ id: 'r3' }], skipToken: 'page-3', resultTruncated: 'false' })
      .mockResolvedValueOnce({ data: [{ id: 'r4' }], resultTruncated: 'false' });

    const client = new ResourceGraphClient({ credential: FAKE_CREDENTIAL, subscriptionIds: ['sub-1'] });
    const rows = await client.queryAll('resources');

    expect(rows).toEqual([{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }, { id: 'r4' }]);
    expect(resourcesMock).toHaveBeenCalledTimes(3);
  });

  it('passes the prior page\'s skipToken back on the next request, not a stale or empty one', async () => {
    resourcesMock
      .mockResolvedValueOnce({ data: [{ id: 'r1' }], skipToken: 'page-2-token', resultTruncated: 'false' })
      .mockResolvedValueOnce({ data: [{ id: 'r2' }], resultTruncated: 'false' });

    const client = new ResourceGraphClient({ credential: FAKE_CREDENTIAL, subscriptionIds: ['sub-1'] });
    await client.queryAll('resources');

    const secondCallOptions = (resourcesMock.mock.calls[1]![0] as { options: { skipToken?: string } }).options;
    expect(secondCallOptions.skipToken).toBe('page-2-token');
  });

  it('stops paginating once a page reports no skipToken', async () => {
    resourcesMock.mockResolvedValueOnce({ data: [{ id: 'r1' }], resultTruncated: 'false' });

    const client = new ResourceGraphClient({ credential: FAKE_CREDENTIAL, subscriptionIds: ['sub-1'] });
    await client.queryAll('resources');

    expect(resourcesMock).toHaveBeenCalledTimes(1);
  });
});

describe('ResourceGraphClient — resultTruncated', () => {
  it('throws ResourceGraphTruncatedError after full pagination when any page was truncated', async () => {
    resourcesMock
      .mockResolvedValueOnce({ data: [{ id: 'r1' }], skipToken: 'page-2', resultTruncated: 'false' })
      .mockResolvedValueOnce({ data: [{ id: 'r2' }], resultTruncated: 'true' });

    const client = new ResourceGraphClient({ credential: FAKE_CREDENTIAL, subscriptionIds: ['sub-1'] });
    await expect(client.queryAll('resources')).rejects.toBeInstanceOf(ResourceGraphTruncatedError);
  });

  it('still yields every row seen before the truncation was reported, not just an empty result', async () => {
    resourcesMock.mockResolvedValueOnce({ data: [{ id: 'r1' }, { id: 'r2' }], resultTruncated: 'true' });

    const client = new ResourceGraphClient({ credential: FAKE_CREDENTIAL, subscriptionIds: ['sub-1'] });
    const rows: unknown[] = [];
    await expect((async () => {
      for await (const row of client.query('resources')) rows.push(row);
    })()).rejects.toBeInstanceOf(ResourceGraphTruncatedError);
    expect(rows).toEqual([{ id: 'r1' }, { id: 'r2' }]);
  });

  it('reports the true row count seen across every page in the truncation error', async () => {
    resourcesMock
      .mockResolvedValueOnce({ data: [{ id: 'r1' }, { id: 'r2' }], skipToken: 'page-2', resultTruncated: 'false' })
      .mockResolvedValueOnce({ data: [{ id: 'r3' }], resultTruncated: 'true' });

    const client = new ResourceGraphClient({ credential: FAKE_CREDENTIAL, subscriptionIds: ['sub-1'] });
    try {
      await client.queryAll('resources');
      expect.unreachable('expected ResourceGraphTruncatedError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ResourceGraphTruncatedError);
      expect((err as InstanceType<typeof ResourceGraphTruncatedError>).rowsSeen).toBe(3);
    }
  });

  it('does not throw when no page reports truncation', async () => {
    resourcesMock.mockResolvedValueOnce({ data: [{ id: 'r1' }], resultTruncated: 'false' });

    const client = new ResourceGraphClient({ credential: FAKE_CREDENTIAL, subscriptionIds: ['sub-1'] });
    await expect(client.queryAll('resources')).resolves.toEqual([{ id: 'r1' }]);
  });
});
