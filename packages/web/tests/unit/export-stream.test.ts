/**
 * ADR 0007: the export streams. `streamExport` (lib/export-stream.ts) turns a source of finding pieces
 * into a response body, and these tests hold it to what a download needs of it: the first bytes arrive
 * while the source is still being read, a source is read only as fast as the download takes it, a
 * download that goes away or stalls lets the source go, and a failure never puts an error in the file.
 * The source is a stub, so what the stream asks of it is what the tests watch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamExport, type ExportSource, type OpenExport } from '@/lib/export-stream';
import type { ExportFinding, ExportPiece } from '@/lib/findings-export';

const finding = (name: string): ExportFinding => ({
  module: 'security', ruleId: 'rule-1', fingerprint: `fp-${name}`, severity: 'high', category: 'security',
  resourceType: 'Microsoft.Compute/virtualMachines', resourceName: name, subscriptionId: 'sub', resourceGroup: 'rg', location: 'westeurope',
  title: 'Example', description: 'desc', recommendation: 'fix', remediationSteps: [], azurePortalLink: '', detectedAt: '2026-01-01T00:00:00.000Z',
  status: 'active', firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-02T00:00:00.000Z', timesSeen: 2,
});
const piece = (name: string, rows: Record<string, unknown>[] = [{ zone: '1' }]): ExportPiece => ({ finding: finding(name), rows, start: true, end: true });

/** A source that hands out the batches given, one by one, and says how far it was read. */
function stubSource(batches: ExportPiece[][], hooks: { before?: (index: number) => Promise<void>; closed?: () => void } = {}) {
  const state = { read: 0, finished: false, returned: false };
  const source: ExportSource = {
    columns: async () => ({ evidenceKeys: ['zone'], lifecycle: true }),
    async *batches() {
      try {
        for (const [index, batch] of batches.entries()) {
          await hooks.before?.(index);
          state.read += 1;
          yield batch;
        }
        state.finished = true;
      } finally {
        state.returned = true;
        hooks.closed?.();
      }
    },
  };
  const closed = new Promise<void>(resolve => { hooks.closed = resolve; });
  const open: OpenExport = read => read(source);
  return { open, state, closed };
}

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
const decoder = new TextDecoder();
async function readAll(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
}

afterEach(() => { vi.restoreAllMocks(); });

describe('the first bytes of an export', () => {
  it.each(['csv', 'json'] as const)('arrive while the source is still being read (%s)', async (format) => {
    const second = gate();
    const { open, state } = stubSource([[piece('vm-one')], [piece('vm-two')]], { before: i => (i === 1 ? second.promise : Promise.resolve()) });
    const body = await streamExport(open, format);
    const reader = body.getReader();
    const first = decoder.decode((await reader.read()).value);
    // The source is held up before its second batch, so the first chunk cannot hold the whole file.
    expect(state.read).toBe(1);
    expect(state.finished).toBe(false);
    expect(first).toContain('vm-one');
    expect(first).not.toContain('vm-two');
    second.release();
    let rest = '';
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest += decoder.decode(r.value);
    expect(rest).toContain('vm-two');
    expect(state.finished).toBe(true);
  });

  it('are the CSV header, then one line a row', async () => {
    const { open } = stubSource([[piece('vm-one', [{ zone: '1' }, { zone: '2' }])]]);
    const text = await readAll(await streamExport(open, 'csv'));
    expect(text).toBe([
      'Severity,Title,Resource,ResourceGroup,Location,Subscription,ResourceType,RuleId,Violation,DetectedAt,PortalLink,Status,FirstSeen,LastSeen,TimesSeen,zone',
      'high,Example,vm-one,rg,westeurope,sub,Microsoft.Compute/virtualMachines,rule-1,,2026-01-01T00:00:00.000Z,,active,2026-01-01T00:00:00.000Z,2026-01-02T00:00:00.000Z,2,1',
      'high,Example,vm-one,rg,westeurope,sub,Microsoft.Compute/virtualMachines,rule-1,,2026-01-01T00:00:00.000Z,,active,2026-01-01T00:00:00.000Z,2026-01-02T00:00:00.000Z,2,2',
    ].join('\n'));
  });

  it('are an empty array for a JSON export of nothing, and a lone header for a CSV one', async () => {
    const empty = stubSource([]);
    expect(await readAll(await streamExport(empty.open, 'json'))).toBe('[]');
    const csv = await readAll(await streamExport(stubSource([]).open, 'csv'));
    expect(csv.split('\n')).toHaveLength(1);
    expect(csv.startsWith('Severity,Title,')).toBe(true);
  });
});

describe('how fast the source is read', () => {
  it('is only as fast as the download takes it: a download that reads nothing leaves most of a large export unread', async () => {
    const batches = Array.from({ length: 200 }, (_, i) => [piece(`vm-${i}`)]);
    const { open, state } = stubSource(batches);
    const body = await streamExport(open, 'json');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(state.read).toBeLessThan(10);
    expect((await readAll(body)).match(/"resourceName"/g)).toHaveLength(200);
  });
});

describe('a download that goes away', () => {
  it('lets the source go when the reader cancels, without calling that a failure', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hold = gate();
    const { open, state, closed } = stubSource(Array.from({ length: 50 }, () => [piece('vm-one')]), { before: i => (i === 20 ? hold.promise : Promise.resolve()) });
    const reader = (await streamExport(open, 'csv')).getReader();
    await reader.read();
    await reader.cancel();
    await closed;
    expect(state.returned).toBe(true);
    expect(state.finished).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(log).not.toHaveBeenCalled();
  });

  it('does not log a source that fails after the download went, since nobody is left to be told', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hold = gate();
    const { open, closed } = stubSource([[piece('vm-one')], [piece('vm-two')]], { before: i => (i === 1 ? hold.promise.then(() => { throw new Error('late failure'); }) : Promise.resolve()) });
    const reader = (await streamExport(open, 'csv')).getReader();
    await reader.read();
    await reader.cancel();
    hold.release();
    await closed;
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(log).not.toHaveBeenCalled();
  });

  it('lets the source go when nothing reads for the stall time, and says so in the log', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { open, state, closed } = stubSource(Array.from({ length: 50 }, (_, i) => [piece(`vm-${i}`)]));
    const reader = (await streamExport(open, 'json', { stallMs: 20 })).getReader();
    await closed;
    expect(state.finished).toBe(false);
    // The source is let go before the failure is logged, so the log is waited for.
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    await expect(reader.read()).rejects.toThrow();
  });
});

describe('a failure', () => {
  it('before the first byte rejects, so the route can answer with the stable message', async () => {
    const failing: OpenExport = read => read({
      columns: async () => { throw new Error('connection to 10.1.2.3 refused'); },
      async *batches() { yield [piece('vm-one')]; },
    });
    await expect(streamExport(failing, 'csv')).rejects.toThrow('connection to 10.1.2.3 refused');
    const failingRead: OpenExport = read => read({
      columns: async () => ({ evidenceKeys: [], lifecycle: true }),
      async *batches() { throw new Error('read failed'); },
    });
    await expect(streamExport(failingRead, 'json')).rejects.toThrow('read failed');
  });

  it('after the first byte cuts the stream off and logs it, and the error text is never in the data', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failNow = gate();
    const source: ExportSource = {
      columns: async () => ({ evidenceKeys: ['zone'], lifecycle: true }),
      async *batches() {
        yield [piece('vm-one')];
        await failNow.promise;
        throw new Error('connection to 10.1.2.3 refused for tenant 11111111-2222-3333-4444-555555555555');
      },
    };
    const reader = (await streamExport(read => read(source), 'csv')).getReader();
    const first = decoder.decode((await reader.read()).value);
    expect(first).toContain('vm-one');
    failNow.release();
    const outcome = await reader.read().then(() => 'ended', (err: Error) => err.message);
    // A clean end would leave a file that looks whole; the stream errors instead, with a stable message.
    expect(outcome).not.toBe('ended');
    expect(outcome).not.toMatch(/10\.1\.2\.3|tenant/);
    expect(first).not.toMatch(/10\.1\.2\.3|tenant|refused/);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![1])).toContain('refused for tenant');
  });
});
