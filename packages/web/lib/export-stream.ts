/**
 * Turns an export's source into a response body, a batch of findings at a time (ADR 0007). The body is
 * a `ReadableStream` that the source is read for only as fast as the download takes it, so neither the
 * server nor the browser ever holds the file.
 *
 * The source lives inside one read snapshot (`OpenExport`), which this module keeps open for as long
 * as the body is being read and lets go of the moment it stops being: the download finishing, going away,
 * or not reading for `STALL_MS`. The snapshot holds one connection of its own (a read-only SQLite
 * connection, or a Postgres pool connection) and takes no lock anyone else waits on, so a slow download
 * never holds up the rest of the app; the stall limit bounds how long a download that has stopped can
 * keep its connection and its snapshot.
 *
 * Failure splits on the first byte. Before it the response has no status yet, so the failure is the
 * caller's to answer. After it the status is sent and cannot change, so the body is cut off with an
 * error (the browser sees a failed download, not a short file that looks whole) and the cause is only
 * logged. No error text is ever written into the file.
 *
 * What is streamed is not this module's business: `streamBody` takes a `BodyWriter` that says what the
 * head, each batch and the tail of the body are. The findings export is one writer (`streamExport`), and
 * the snapshot export (lib/snapshot-export.ts) is another, on the same stall, cancel and failure rules.
 */
import { CsvWriter, JsonWriter, type ExportFormat, type ExportPiece } from './findings-export';

/** What an export reads, inside one read transaction. */
export interface ExportSource {
  /** What the CSV header needs before the first row: every evidence key a row carries, sorted, and
   *  whether the findings carry lifecycle fields. Only asked for a CSV. */
  columns(): Promise<{ evidenceKeys: string[]; lifecycle: boolean }>;
  /** The findings in the view's order, a batch at a time. */
  batches(): AsyncIterable<ExportPiece[]>;
}

/** Opens the source in a snapshot and keeps it open until `use` settles. */
export type OpenExport = <T>(use: (source: ExportSource) => Promise<T>) => Promise<T>;

/** Opens a source in a snapshot and keeps it open until `use` settles. */
export type OpenBody<S> = <T>(use: (source: S) => Promise<T>) => Promise<T>;

/** What a body is made of, read from a source. */
export interface BodyWriter<S> {
  /** The text before the first batch. May read from the source (a CSV header needs every column). */
  head(source: S): Promise<string>;
  /** The source's batches, each as the text it is written as. */
  batches(source: S): AsyncIterable<string>;
  /** The text that closes the body. */
  tail(): string;
}

/** How long a download may go without reading before the export is dropped. */
export const STALL_MS = 60_000;

const STOPPED = 'The export was stopped before it finished.';

class Stalled extends Error {
  constructor() {
    super('The download stopped reading.');
  }
}

/** The findings export's body: a CSV or a JSON array, a piece of a finding at a time. */
function exportWriter(format: ExportFormat): BodyWriter<ExportSource> {
  let csv: CsvWriter | null = null;
  const json = format === 'json' ? new JsonWriter() : null;
  return {
    async head(source) {
      if (format !== 'csv') return '';
      const columns = await source.columns();
      csv = new CsvWriter(columns.evidenceKeys, columns.lifecycle);
      return csv.header();
    },
    async *batches(source) {
      for await (const batch of source.batches()) yield batch.map(piece => (csv ?? json!).piece(piece)).join('');
    },
    tail: () => json?.close() ?? '',
  };
}

export function streamExport(
  open: OpenExport, format: ExportFormat, opts: { stallMs?: number } = {},
): Promise<ReadableStream<Uint8Array>> {
  return streamBody(open, exportWriter(format), opts);
}

export async function streamBody<S>(
  open: OpenBody<S>, writer: BodyWriter<S>, opts: { stallMs?: number } = {},
): Promise<ReadableStream<Uint8Array>> {
  const stallMs = opts.stallMs ?? STALL_MS;
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  let wake: (() => void) | undefined;

  const body = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    pull() { wake?.(); },
    cancel() { cancelled = true; wake?.(); },
  }, { highWaterMark: 1 });

  let firstByte = false;
  let settleFirst!: { resolve: () => void; reject: (err: unknown) => void };
  const first = new Promise<void>((resolve, reject) => { settleFirst = { resolve, reject }; });

  /** Hands the download `text`, then waits until it wants more. False once it has gone away. */
  async function push(text: string): Promise<boolean> {
    if (cancelled) return false;
    controller.enqueue(encoder.encode(text));
    if (!firstByte) {
      firstByte = true;
      settleFirst.resolve();
    }
    while (!cancelled && (controller.desiredSize ?? 0) <= 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Stalled()), stallMs);
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
      });
    }
    return !cancelled;
  }

  async function produce(source: S): Promise<void> {
    let pending = await writer.head(source);
    for await (const batch of writer.batches(source)) {
      const text = pending + batch;
      pending = '';
      if (text !== '' && !(await push(text))) return;
    }
    // The last chunk is the one that closes the file, so there is nothing left to wait for after it.
    const last = pending + writer.tail();
    if (cancelled) return;
    controller.enqueue(encoder.encode(last));
    if (!firstByte) {
      firstByte = true;
      settleFirst.resolve();
    }
    controller.close();
  }

  void open(produce).catch((err: unknown) => {
    if (!firstByte) {
      settleFirst.reject(err);
      return;
    }
    if (cancelled) return;
    console.error('[RuleBeat] Export stopped after it started:', err);
    controller.error(new Error(STOPPED));
  });

  await first;
  return body;
}
