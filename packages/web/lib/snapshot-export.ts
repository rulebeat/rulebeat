/**
 * What a snapshot export file holds (ADR 0008): the records of one past scan that match a query, a batch
 * at a time. CSV opens with the columns the screen shows under the headers the screen shows, then the
 * rest of each record; JSON is an array of the records with their own field names. Neither holds a
 * finding's rows or its status, which belong to the live finding.
 *
 * The streaming (first bytes early, a stalled or cancelled download letting go, failure never written
 * into the file) is `streamBody`'s, shared with the findings export.
 */
import { csvRow } from './csv';
import { streamBody, type BodyWriter, type OpenBody } from './export-stream';
import type { ExportFormat } from './findings-export';
import { SNAPSHOT_EXPORT_COLUMNS, type SnapshotRecord } from './snapshot-response';

/** What a snapshot export reads, inside one read snapshot. */
export interface SnapshotExportSource {
  /** The matching records in the snapshot's order, a batch at a time. */
  batches(): AsyncIterable<SnapshotRecord[]>;
}

export type OpenSnapshotExport = OpenBody<SnapshotExportSource>;

const csvLine = (record: SnapshotRecord) => csvRow(SNAPSHOT_EXPORT_COLUMNS.map(column => record[column.key]));

/** The records as a JSON array in the layout `JSON.stringify(records, null, 2)` gives, one element at a time. */
class RecordsJson {
  private elements = 0;

  piece(record: SnapshotRecord): string {
    const element = `  ${JSON.stringify(record, null, 2).replace(/\n/g, '\n  ')}`;
    return `${this.elements++ === 0 ? '[\n' : ',\n'}${element}`;
  }

  close(): string {
    return this.elements === 0 ? '[]' : '\n]';
  }
}

/** CSV with no trailing newline, so every line after the header opens with one, like the findings CSV. */
function snapshotWriter(format: ExportFormat): BodyWriter<SnapshotExportSource> {
  const json = new RecordsJson();
  return {
    async head() {
      return format === 'csv' ? csvRow(SNAPSHOT_EXPORT_COLUMNS.map(column => column.header)) : '';
    },
    async *batches(source) {
      for await (const batch of source.batches()) {
        yield batch.map(record => (format === 'csv' ? `\n${csvLine(record)}` : json.piece(record))).join('');
      }
    },
    tail: () => (format === 'json' ? json.close() : ''),
  };
}

export function streamSnapshotExport(
  open: OpenSnapshotExport, format: ExportFormat, opts: { stallMs?: number } = {},
): Promise<ReadableStream<Uint8Array>> {
  return streamBody(open, snapshotWriter(format), opts);
}
