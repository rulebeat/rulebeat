/**
 * ADR 0008: the snapshot export is streamed by the same machinery as the findings export, from a source
 * of record batches. The source here is a stub, so what the stream asks of it is what the tests watch:
 * the first bytes arrive while a later batch is still held up, a source is read only as fast as the
 * download takes it, a download that goes away lets the source go, and a failure after the first byte
 * cuts the body off without writing an error into it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamSnapshotExport, type OpenSnapshotExport, type SnapshotExportSource } from '@/lib/snapshot-export';
import type { SnapshotRecord } from '@/lib/snapshot-response';

const record = (name: string): SnapshotRecord => ({
  fingerprint: `fp-${name}`, ruleId: 'rule-1', severity: 'high', title: 'Example', kind: 'state',
  resourceId: `/subscriptions/s/${name}`, resourceName: name, resourceType: 'Microsoft.Compute/virtualMachines',
  resourceGroup: 'rg', subscriptionId: 'sub', rowCount: 2,
});

/** A source that hands out the batches given, one by one, and says how far it was read. */
function stubSource(batches: SnapshotRecord[][], hooks: { before?: (index: number) => Promise<void>; fail?: number } = {}) {
  const state = { read: 0, finished: false, returned: false };
  const source: SnapshotExportSource = {
    async *batches() {
      try {
        for (const [index, batch] of batches.entries()) {
          await hooks.before?.(index);
          if (hooks.fail === index) throw new Error('database says: tenant 00000000 unreachable');
          state.read += 1;
          yield batch;
        }
        state.finished = true;
      } finally {
        state.returned = true;
      }
    },
  };
  const open: OpenSnapshotExport = withSource => withSource(source);
  return { open, state };
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

describe('the first bytes of a snapshot export', () => {
  it.each(['csv', 'json'] as const)('arrive while the source is still being read (%s)', async (format) => {
    const second = gate();
    const { open, state } = stubSource([[record('vm-one')], [record('vm-two')]], { before: i => (i === 1 ? second.promise : Promise.resolve()) });
    const reader = (await streamSnapshotExport(open, format)).getReader();
    const first = decoder.decode((await reader.read()).value);
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
});

describe('the text of a snapshot export', () => {
  it('is the header, then one line a record, without a trailing newline (csv)', async () => {
    const { open } = stubSource([[record('vm-one')], [record('vm-two')]]);
    expect(await readAll(await streamSnapshotExport(open, 'csv'))).toBe([
      'Severity,Rule,Resource,Type,Resource group,Rows,Subscription,Resource ID,Rule ID,Kind,Fingerprint',
      'high,Example,vm-one,Microsoft.Compute/virtualMachines,rg,2,sub,/subscriptions/s/vm-one,rule-1,state,fp-vm-one',
      'high,Example,vm-two,Microsoft.Compute/virtualMachines,rg,2,sub,/subscriptions/s/vm-two,rule-1,state,fp-vm-two',
    ].join('\n'));
  });

  it('is the records as JSON, the text JSON.stringify gives for them', async () => {
    const records = [record('vm-one'), record('vm-two'), record('vm-three')];
    const { open } = stubSource([records.slice(0, 2), records.slice(2)]);
    expect(await readAll(await streamSnapshotExport(open, 'json'))).toBe(JSON.stringify(records, null, 2));
  });

  it('is an empty array, or the header alone, when there are no records', async () => {
    expect(await readAll(await streamSnapshotExport(stubSource([]).open, 'json'))).toBe('[]');
    expect(await readAll(await streamSnapshotExport(stubSource([]).open, 'csv'))).toBe(
      'Severity,Rule,Resource,Type,Resource group,Rows,Subscription,Resource ID,Rule ID,Kind,Fingerprint',
    );
  });
});

describe('a snapshot export that stops', () => {
  it('lets the source go when the download goes away', async () => {
    const second = gate();
    const { open, state } = stubSource([[record('vm-one')], [record('vm-two')], [record('vm-three')]], { before: i => (i === 1 ? second.promise : Promise.resolve()) });
    const body = await streamSnapshotExport(open, 'json');
    const reader = body.getReader();
    await reader.read();
    await reader.cancel();
    second.release();
    await vi.waitFor(() => expect(state.returned).toBe(true));
    expect(state.finished).toBe(false);
  });

  it('answers a failure before the first byte to the caller, not into the file', async () => {
    const { open } = stubSource([[record('vm-one')]], { fail: 0 });
    await expect(streamSnapshotExport(open, 'csv')).rejects.toThrow('unreachable');
  });

  it('cuts the body off after the first byte, with no error text in it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { open } = stubSource([[record('vm-one')], [record('vm-two')]], { fail: 1 });
    const reader = (await streamSnapshotExport(open, 'json')).getReader();
    const first = decoder.decode((await reader.read()).value);
    expect(first).toContain('vm-one');
    const failure = await reader.read().then(() => null, (err: Error) => err);
    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).not.toContain('tenant');
    expect(first).not.toContain('tenant');
  });
});
