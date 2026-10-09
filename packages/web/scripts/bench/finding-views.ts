/**
 * The benchmark behind `npm run bench:views` (ADR 0007): how long and how many bytes it
 * takes to answer a findings view the way the explorer does today (every finding with every row
 * sent to the browser, the view computed there) against the new way (the view computed on the server
 * and only the page sent).
 *
 * Two halves, both importable so a test can run them at a tiny size:
 *  - `generateDataset()` is pure. The same seed always gives the same rules, resources and rows.
 *  - `runBench()` writes that dataset through the real scan save (`runCategoryScan` over the fake
 *    Azure context), then runs a list of named async measurements through one harness.
 *
 * It uses whichever database the process has open and never opens one itself, so the CLI wrapper
 * (`scripts/bench-finding-views.ts`) points a fresh temp file at the process first and a test uses
 * its own. Every repository import here is dynamic for the same reason as in `generate-demo.ts`.
 */

// ---- The dataset ----

export interface DatasetOptions {
  /** How many findings the first scan saves. */
  findings: number;
  /** The average number of rows each finding holds. */
  rowsPerFinding: number;
  seed: number;
}

export interface PlannedRule {
  id: string;
  name: string;
  category: 'security' | 'cost' | 'reliability';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  kind: 'state' | 'advisory';
  tags?: string[];
}

export interface PlannedResource {
  index: number;
  name: string;
  ruleId: string;
  subscriptionId: string;
  resourceGroup: string;
  location: string;
  type: string;
  rowCount: number;
  /** Absent from the second scan, so its finding ends up Fixed. */
  fixedByLaterScan: boolean;
  /** Gets a suppression after the scans. */
  suppressed: boolean;
}

export interface Dataset { rules: PlannedRule[]; resources: PlannedResource[] }

export const BENCH_RULES: readonly PlannedRule[] = [
  { id: 'bench-sec-critical', name: 'Public management ports', category: 'security', severity: 'critical', kind: 'state', tags: ['network'] },
  { id: 'bench-sec-high-a', name: 'Unencrypted disks', category: 'security', severity: 'high', kind: 'state', tags: ['encryption'] },
  { id: 'bench-sec-high-b', name: 'Missing diagnostic settings', category: 'security', severity: 'high', kind: 'state' },
  { id: 'bench-sec-medium', name: 'Outdated TLS versions', category: 'security', severity: 'medium', kind: 'state', tags: ['network', 'tls'] },
  { id: 'bench-cost-medium', name: 'Premium disks on idle machines', category: 'cost', severity: 'medium', kind: 'state', tags: ['finops'] },
  { id: 'bench-cost-low-a', name: 'Unattached public addresses', category: 'cost', severity: 'low', kind: 'state', tags: ['finops'] },
  { id: 'bench-cost-low-b', name: 'Oversized gateways', category: 'cost', severity: 'low', kind: 'state' },
  { id: 'bench-rel-high', name: 'Single-zone databases', category: 'reliability', severity: 'high', kind: 'state' },
  { id: 'bench-adv-retire', name: 'Service retirements', category: 'reliability', severity: 'medium', kind: 'advisory' },
  { id: 'bench-adv-sku', name: 'SKU changes', category: 'reliability', severity: 'low', kind: 'advisory' },
  { id: 'bench-adv-info', name: 'Preview features ending', category: 'reliability', severity: 'info', kind: 'advisory' },
  { id: 'bench-adv-tls', name: 'Protocol deprecations', category: 'reliability', severity: 'medium', kind: 'advisory', tags: ['tls'] },
];

export const BENCH_SUBSCRIPTIONS = [1, 2, 3, 4, 5].map(n => `${n}${n}${n}${n}${n}${n}${n}${n}-0000-4000-8000-00000000000${n}`);
const LOCATIONS = ['westeurope', 'northeurope', 'eastus', 'eastus2', 'uksouth', 'southeastasia'];
const TYPES = ['microsoft.compute/virtualmachines', 'microsoft.storage/storageaccounts', 'microsoft.sql/servers'];
const SKUS = ['S1', 'S2', 'S3', 'P1', 'P2'];
const TIERS = ['Basic', 'Standard', 'Premium'];
const RETIREMENTS = ['Basic tier', 'Gen1 images', 'TLS 1.0', 'Classic gateways', 'Legacy runtimes'];
const FILLER = ['configuration', 'resource', 'policy', 'network', 'managed', 'identity', 'encryption', 'regional', 'replica', 'diagnostic', 'endpoint', 'baseline'];

/** The path the row-filter and column-dropdown measurements use. */
export const BENCH_ROW_PATH = 'properties.sku.name';
/** The size one row is padded to, in bytes of JSON: what an Advisor-style recommendation weighs. */
export const ROW_TARGET_BYTES = 1500;

/** A small deterministic generator (mulberry32), so one seed always gives one dataset. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pickFrom = <T>(items: readonly T[], rand: () => number): T => items[Math.floor(rand() * items.length)]!;

export function generateDataset(opts: DatasetOptions): Dataset {
  const rand = seededRandom(opts.seed);
  const resources: PlannedResource[] = [];
  for (let index = 0; index < opts.findings; index += 1) {
    // Squared, so a few rules hold most findings and the rest hold few, as real tenants do.
    const rule = BENCH_RULES[Math.floor(rand() ** 1.6 * BENCH_RULES.length)]!;
    const sub = Math.floor(rand() * BENCH_SUBSCRIPTIONS.length);
    resources.push({
      index,
      name: `res-${String(index).padStart(6, '0')}`,
      ruleId: rule.id,
      subscriptionId: BENCH_SUBSCRIPTIONS[sub]!,
      resourceGroup: `rg-${sub + 1}-${Math.floor(rand() * 8)}`,
      location: pickFrom(LOCATIONS, rand),
      type: pickFrom(TYPES, rand),
      rowCount: Math.max(1, opts.rowsPerFinding + Math.floor(rand() * 3) - 1),
      fixedByLaterScan: rand() < 0.08,
      suppressed: rand() < 0.01,
    });
  }
  return { rules: [...BENCH_RULES], resources };
}

/** One row of a finding: ~1.5 KB of nested JSON shaped like a recommendation, the same every time
 *  for the same seed, resource and row number. */
export function generateRow(seed: number, resource: PlannedResource, rowNumber: number): Record<string, unknown> {
  const rand = seededRandom((seed ^ Math.imul(resource.index + 1, 2654435761) ^ Math.imul(rowNumber + 1, 40503)) >>> 0);
  const row: Record<string, unknown> = {
    id: `/subscriptions/${resource.subscriptionId}/resourceGroups/${resource.resourceGroup}/providers/${resource.type}/${resource.name}`,
    name: resource.name,
    type: resource.type,
    location: resource.location,
    resourceGroup: resource.resourceGroup,
    subscriptionId: resource.subscriptionId,
    zone: String(1 + Math.floor(rand() * 3)),
    retirement: pickFrom(RETIREMENTS, rand),
    properties: {
      sku: { name: pickFrom(SKUS, rand), tier: pickFrom(TIERS, rand), capacity: 1 + Math.floor(rand() * 8) },
      network: {
        interfaces: [0, 1].map(n => ({
          name: `nic-${resource.index}-${n}`,
          address: `10.${Math.floor(rand() * 255)}.${Math.floor(rand() * 255)}.${Math.floor(rand() * 255)}`,
          subnet: { id: `/subscriptions/${resource.subscriptionId}/resourceGroups/${resource.resourceGroup}/subnets/snet-${n}`, prefix: '10.0.0.0/24' },
        })),
        rules: { inbound: { allow: ['443', '8443'], deny: ['22', '3389'] }, outbound: { allow: ['*'] } },
      },
      encryption: { atRest: rand() < 0.5, keySource: pickFrom(['platform', 'customer'], rand), rotation: { days: 30 + Math.floor(rand() * 60) } },
    },
    labels: { env: pickFrom(['prod', 'test', 'dev'], rand), owner: `team-${Math.floor(rand() * 20)}`, costCenter: `cc-${1000 + Math.floor(rand() * 90)}` },
    retiresOn: `2027-0${1 + Math.floor(rand() * 9)}-01`,
  };
  // Pad one text field so every row weighs about the same, whatever the draws above came to.
  const words: string[] = [];
  const missing = () => ROW_TARGET_BYTES - JSON.stringify({ ...row, notes: words.join(' ') }).length;
  while (missing() > 0) words.push(pickFrom(FILLER, rand));
  row.notes = words.join(' ');
  return row;
}

// ---- The harness ----

export interface Measurement {
  name: string;
  /** Does the work once. A returned number is the byte size of what it produced. */
  run: () => Promise<number | void>;
}

export interface MeasurementResult {
  name: string;
  /** The first run in this process: statement preparation and a cold JIT included. */
  coldMs: number;
  /** The median of the warm runs after it. */
  medianMs: number;
  bytes?: number;
}

export interface BenchOptions extends DatasetOptions {
  /** How many runs follow the cold one. */
  warmRuns: number;
}

export interface BenchResult {
  options: BenchOptions;
  dataset: { findings: number; rows: number; averageRowBytes: number; fixed: number; suppressed: number };
  measurements: MeasurementResult[];
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Runs each measurement once cold, then `warmRuns` more times, and keeps the cold time, the median
 *  of the rest and the bytes of the last run. */
export async function runMeasurements(
  measurements: readonly Measurement[],
  warmRuns: number,
  log: (line: string) => void = () => {},
): Promise<MeasurementResult[]> {
  const results: MeasurementResult[] = [];
  for (const measurement of measurements) {
    log(`measuring ${measurement.name}`);
    let bytes: number | undefined;
    const timeOnce = async (): Promise<number> => {
      const start = performance.now();
      const out = await measurement.run();
      const elapsed = performance.now() - start;
      if (typeof out === 'number') bytes = out;
      return elapsed;
    };
    const coldMs = await timeOnce();
    const warm: number[] = [];
    for (let i = 0; i < warmRuns; i += 1) warm.push(await timeOnce());
    results.push({ name: measurement.name, coldMs, medianMs: warm.length ? median(warm) : coldMs, ...(bytes === undefined ? {} : { bytes }) });
  }
  return results;
}

const DAY_MS = 86_400_000;
const kqlOf = (id: string) => `resources | where type != "" // ${id}`;

/** Stores the dataset through the real scan save: a first scan with every resource, then a second a
 *  few days later without the ones marked `fixedByLaterScan`, so some findings end up Fixed. Returns
 *  how long each scan took, since the scan save is itself one of the things measured. */
export async function seedDatabase(
  dataset: Dataset,
  seed: number,
  log: (line: string) => void = () => {},
): Promise<{ firstScanMs: number; secondScanMs: number }> {
  const { eq } = await import('drizzle-orm');
  const { computeFingerprint } = await import('@rulebeat/core');
  const { db } = await import('../../lib/db/client');
  const { run } = await import('../../lib/db/exec');
  const { rules } = await import('../../lib/db/tables');
  const { getCategory } = await import('../../lib/db/categories');
  const { runCategoryScan } = await import('../../lib/scan-runner');
  const { addSuppression } = await import('../../lib/suppressions');
  const { fakeTenantContext } = await import('../../lib/demo/fake-tenant');

  for (const rule of dataset.rules) {
    await run(db.delete(rules).where(eq(rules.id, rule.id)));
    await run(db.insert(rules).values({
      id: rule.id, name: rule.name, description: 'bench rule', category: rule.category, severity: rule.severity, kind: rule.kind,
      enabled: true, scope: JSON.stringify({ level: 'subscription' }), resourceTypes: JSON.stringify([]), conditions: JSON.stringify([]),
      type: 'custom', rawKql: kqlOf(rule.id), tags: rule.tags ? JSON.stringify(rule.tags) : null,
    }));
  }

  const byRule = new Map<string, PlannedResource[]>();
  for (const resource of dataset.resources) byRule.set(resource.ruleId, [...(byRule.get(resource.ruleId) ?? []), resource]);

  const scan = async (label: string, now: Date, includes: (r: PlannedResource) => boolean): Promise<number> => {
    const start = performance.now();
    for (const category of ['security', 'cost', 'reliability'] as const) {
      const ruleIds = dataset.rules.filter(r => r.category === category).map(r => r.id);
      const ctx = fakeTenantContext({
        subscriptionIds: [...BENCH_SUBSCRIPTIONS],
        // Rows are built when the rule's query is asked for them, so only one rule's rows are in memory at a time.
        rows: kql => {
          const id = ruleIds.find(rule => kql.endsWith(`// ${rule}`));
          return (byRule.get(id ?? '') ?? []).filter(includes).flatMap(res => Array.from({ length: res.rowCount }, (_, n) => generateRow(seed, res, n)));
        },
      });
      await runCategoryScan((await getCategory(category))!, { ctx, ruleIds, now });
    }
    const ms = performance.now() - start;
    log(`${label}: ${Math.round(ms)} ms`);
    return ms;
  };

  const now = Date.now();
  const firstScanMs = await scan('first scan', new Date(now - 10 * DAY_MS), () => true);
  const secondScanMs = await scan('second scan', new Date(now - 1 * DAY_MS), r => !r.fixedByLaterScan);

  const suppressedAt = new Date(now - 2 * DAY_MS).toISOString();
  for (const resource of dataset.resources.filter(r => r.suppressed)) {
    const id = `/subscriptions/${resource.subscriptionId}/resourceGroups/${resource.resourceGroup}/providers/${resource.type}/${resource.name}`;
    await addSuppression({ id: `bench-sup-${resource.index}`, fingerprint: computeFingerprint(resource.ruleId, id), reason: 'Accepted', suppressedAt });
  }
  return { firstScanMs, secondScanMs };
}

/** The measurements over a seeded database, today's path first and the new one after it. */
export async function buildMeasurements(): Promise<Measurement[]> {
  const { listFindings } = await import('../../lib/db/findings');
  const { buildExplorerData } = await import('../../lib/explorer-data');
  const { RESULTS_KINDS } = await import('../../lib/finding-kinds');
  const { applyView, emptyView, rowField, rowFieldOptions } = await import('../../lib/finding-view');
  const { queryColumnValues, queryView } = await import('../../lib/db/finding-views');

  const kindsOf = { results: RESULTS_KINDS, advisories: ['advisory'] as const };
  const rowFilterView = { ...emptyView(), filters: [{ field: rowField(BENCH_ROW_PATH), values: ['S1'] }] };
  const defaultView = emptyView();
  const sizeOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

  return [
    // Today: every finding with every row goes to the browser, which computes the view.
    { name: 'today: payload, Results tab', run: async () => sizeOf(await buildExplorerData({ kinds: kindsOf.results })) },
    { name: 'today: payload, Advisories tab', run: async () => sizeOf(await buildExplorerData({ kinds: kindsOf.advisories })) },
    { name: 'today: default view', run: async () => { applyView(await listFindings({ kinds: kindsOf.results }), defaultView); } },
    { name: 'today: row-filtered view', run: async () => { applyView(await listFindings({ kinds: kindsOf.results }), rowFilterView); } },
    { name: 'today: column dropdown', run: async () => { rowFieldOptions(await listFindings({ kinds: kindsOf.results }), [], BENCH_ROW_PATH); } },
    // New: the server computes the view and sends the page.
    { name: 'new: default view', run: async () => sizeOf(await queryView(defaultView, { tab: 'results', showSuppressed: false })) },
    { name: 'new: row-filtered view', run: async () => sizeOf(await queryView(rowFilterView, { tab: 'results', showSuppressed: false })) },
    { name: 'new: default view, Advisories tab', run: async () => sizeOf(await queryView(defaultView, { tab: 'advisories', showSuppressed: false })) },
    { name: 'new: column dropdown', run: async () => sizeOf(await queryColumnValues(defaultView, { tab: 'results', showSuppressed: false, column: rowField(BENCH_ROW_PATH) })) },
  ];
}

export async function runBench(opts: BenchOptions, log: (line: string) => void = () => {}): Promise<BenchResult> {
  const dataset = generateDataset(opts);
  log(`seeding ${dataset.resources.length} findings`);
  const scans = await seedDatabase(dataset, opts.seed, log);

  const sample = dataset.resources.slice(0, 200).flatMap(r => Array.from({ length: r.rowCount }, (_, n) => Buffer.byteLength(JSON.stringify(generateRow(opts.seed, r, n)))));
  const measurements = await runMeasurements(await buildMeasurements(), opts.warmRuns, log);

  return {
    options: opts,
    dataset: {
      findings: dataset.resources.length,
      rows: dataset.resources.reduce((sum, r) => sum + r.rowCount, 0),
      averageRowBytes: sample.length ? Math.round(sample.reduce((a, b) => a + b, 0) / sample.length) : 0,
      fixed: dataset.resources.filter(r => r.fixedByLaterScan).length,
      suppressed: dataset.resources.filter(r => r.suppressed).length,
    },
    measurements: [
      { name: 'scan save: first scan', coldMs: scans.firstScanMs, medianMs: scans.firstScanMs },
      { name: 'scan save: second scan', coldMs: scans.secondScanMs, medianMs: scans.secondScanMs },
      ...measurements,
    ],
  };
}

// ---- The report ----

const ms = (value: number) => (value >= 100 ? Math.round(value) : Math.round(value * 10) / 10).toLocaleString('en-US');
const size = (bytes: number) => (bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`);

export function formatTable(result: BenchResult): string {
  const { dataset, options } = result;
  const header = ['measurement', 'cold ms', 'median ms', 'bytes sent'];
  const body = result.measurements.map(m => [
    m.name, ms(m.coldMs), m.name.startsWith('scan save') ? 'n/a' : ms(m.medianMs), m.bytes === undefined ? '' : size(m.bytes),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map(row => row[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ').trimEnd();
  return [
    `${dataset.findings.toLocaleString('en-US')} findings, ${dataset.rows.toLocaleString('en-US')} rows (about ${dataset.averageRowBytes} bytes each), `
      + `${dataset.fixed.toLocaleString('en-US')} fixed by the second scan, ${dataset.suppressed.toLocaleString('en-US')} suppressed, `
      + `seed ${options.seed}, ${options.warmRuns} warm runs`,
    '',
    line(header),
    line(widths.map(w => '-'.repeat(w))),
    ...body.map(line),
  ].join('\n');
}
