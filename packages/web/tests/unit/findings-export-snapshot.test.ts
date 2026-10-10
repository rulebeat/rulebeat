/**
 * ADR 0007: an export reads one snapshot of the database and never holds up the rest of the app while
 * its download is read. On SQLite the app has one shared connection and one lock every transaction
 * waits on, so an export that took that lock for as long as a slow download ran would stop every scan
 * save and every view read behind it. The export reads on a connection of its own instead.
 *
 * These tests go through the route, with a body that is read a chunk at a time, so the export is open
 * (a batch written, the next one waiting for the download) while the other side of each test runs.
 * SQLite only: Postgres gives the export a read-only transaction of its own anyway.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbKind } from '@/lib/db/backend';
import { openSnapshotConnections } from '@/lib/db/snapshot';
import { openExport as openExportSource } from '@/lib/db/finding-views';
import { streamExport } from '@/lib/export-stream';
import { viewToSearchParams, emptyView, type View } from '@/lib/finding-view';
import { resetDb } from '../helpers/db';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';

const mockRequireRole = vi.fn();
vi.mock('@/lib/api-auth', () => ({ requireRole: (...args: unknown[]) => mockRequireRole(...args) }));
const exportRoute = await import('@/app/api/findings/export/route');

const RULE = 'snap-rule';
// More findings than one batch holds, so the export is still reading when its first chunk has been taken.
const STORED = 520;
const named = (i: number) => `snap-${String(i).padStart(4, '0')}`;
const BEFORE = new Date(Date.now() - 86_400_000).toISOString();
const AFTER = new Date().toISOString();

/** How many of the stored findings the text names. */
const namesIn = (text: string) => new Set(text.match(/snap-\d{4}/g)).size;

const view = { ...emptyView(), filters: [{ field: 'rule', values: [RULE] }] } as View;
const query = viewToSearchParams(view, { tab: 'results' });

function openExport(format: 'csv' | 'json'): Promise<Response> {
  mockRequireRole.mockResolvedValue({ id: 'viewer' });
  return exportRoute.GET(new Request(`http://localhost/api/findings/export?${query}&format=${format}`));
}

/** A later scan of the rule that finds one resource the export has not seen, and no longer finds the rest. */
const laterScan = () => storeScan([syntheticFinding('late-0000', [{ part: 'late' }], { ruleId: RULE })], { scanId: 'scan-late', finishedAt: AFTER });

/** True when `work` finished within `ms`. A write that is blocked fails a test here instead of hanging it. */
async function finishesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); });
  try {
    return await Promise.race([work.then(() => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

describe.skipIf(dbKind !== 'sqlite')('an export that is being downloaded', () => {
  const open: ReadableStreamDefaultReader<Uint8Array>[] = [];

  /** The rule's findings, every one active, as a scan before `laterScan` left them. */
  async function seed() {
    await resetDb();
    await storeScan(Array.from({ length: STORED }, (_, i) => syntheticFinding(named(i), [{ part: 'a' }], { ruleId: RULE })), { scanId: 'scan-snap', finishedAt: BEFORE });
  }

  beforeEach(seed);

  const writes: Promise<unknown>[] = [];
  /** A write that a test waits on for a moment; afterEach waits for it to finish whatever the outcome. */
  const writeWithin = (ms: number) => {
    const write = laterScan();
    writes.push(write.catch(() => {}));
    return finishesWithin(write, ms);
  };

  afterEach(async () => {
    // An export that is not read to its end holds its connection until it is cancelled.
    for (const reader of open.splice(0)) await reader.cancel().catch(() => {});
    await Promise.all(writes.splice(0));
  });

  /** An export whose body has not been read yet: its first batch is written, and the rest waits. */
  async function startedExport(format: 'csv' | 'json') {
    const res = await openExport(format);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    open.push(reader);
    const decoder = new TextDecoder();
    const next = async () => { const r = await reader.read(); return r.done ? '' : decoder.decode(r.value); };
    const rest = async () => {
      let text = '';
      for (let chunk = await next(); chunk !== ''; chunk = await next()) text += chunk;
      return text;
    };
    return { next, rest, reader };
  }

  it('does not hold up a write: a scan saved while its body waits to be read completes', async () => {
    await startedExport('json');
    expect(await writeWithin(3000)).toBe(true);
  });

  it.each(['csv', 'json'] as const)('still holds what was stored before that write, as %s', async (format) => {
    const { next, rest } = await startedExport(format);
    expect(await writeWithin(3000)).toBe(true);
    // Nothing has been taken from the body yet, so every batch after the first is read after the write.
    const first = await next();
    expect(namesIn(first)).toBeLessThan(STORED);
    const file = first + await rest();
    for (const i of [0, 1, STORED - 1]) expect(file).toContain(named(i));
    expect(namesIn(file)).toBe(STORED);
    expect(file).not.toContain('late-0000');
    // The write resolved every one of them, which the second half of the file must not show.
    expect(file).not.toContain('fixed');
    expect(file).not.toContain('resolved');
    // The write did land: a fresh export sees it.
    const after = await (await openExport(format)).text();
    expect(after).toContain('late-0000');
    expect(after).not.toContain(named(0));
  });

  it('uses one connection of its own while it is open, and gives it up when the download reads to the end', async () => {
    expect(openSnapshotConnections()).toBe(0);
    const { rest } = await startedExport('json');
    expect(openSnapshotConnections()).toBe(1);
    await rest();
    await vi.waitFor(() => expect(openSnapshotConnections()).toBe(0));
  });
  it('gives its connection up when the download is cancelled', async () => {
    const { reader } = await startedExport('csv');
    expect(openSnapshotConnections()).toBe(1);
    await reader.cancel();
    await vi.waitFor(() => expect(openSnapshotConnections()).toBe(0));
  });

  it('gives its connection up when the download stops reading', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = await streamExport(openExportSource(view, { tab: 'results', showSuppressed: false }), 'json', { stallMs: 50 });
    const reader = body.getReader();
    open.push(reader);
    await reader.read();
    expect(openSnapshotConnections()).toBe(1);
    await vi.waitFor(() => expect(openSnapshotConnections()).toBe(0));
    // The body is cut off, not left to look whole.
    await expect(reader.read()).rejects.toThrow('The export was stopped before it finished.');
  });

  it('gives its connection up when the read fails after the first byte', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing: typeof openExportSource = (view, request) => use => openExportSource(view, request)(source => use({
      columns: source.columns,
      async *batches() {
        yield* (async function* () { for await (const batch of source.batches()) { yield batch; break; } })();
        throw new Error('disk I/O error');
      },
    }));
    const reader = (await streamExport(failing(view, { tab: 'results', showSuppressed: false }), 'json')).getReader();
    open.push(reader);
    await reader.read();
    await expect(reader.read()).rejects.toThrow('The export was stopped before it finished.');
    await vi.waitFor(() => expect(openSnapshotConnections()).toBe(0));
  });
});