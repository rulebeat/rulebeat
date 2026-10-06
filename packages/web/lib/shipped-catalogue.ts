import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Rule } from '@rulebeat/core';
import { BUILTIN_RULES } from './builtin-rules';

/**
 * Everything this build ships: RuleBeat Core's definitions plus every pack file under
 * `data/packs/`, as one flat list the startup seeders (`migrate.ts` and `pg/seeds.ts`) both read.
 *
 * It is a parameter of `runSeeds()`/`seedPg()` rather than an import so a test can ship "version 2"
 * of a rule without editing the real rule files. The seeders default it to `loadShippedCatalogue()`.
 */

/** How a pack numbers its versions; chosen per pack in `data/packs/pack-manifest.json`. */
export type VersionScheme = 'semver' | 'upstream-release' | 'upstream-commit-date';

/** The fields of a rule only a version switch may change (ADR 0004). Nulls are explicit so two
 *  definitions compare field for field. */
export interface RuleDefinition {
  name: string;
  description: string;
  category: string;
  severity: string;
  queryBackend: NonNullable<Rule['queryBackend']>;
  kind: NonNullable<Rule['kind']>;
  resourceTypes: string[];
  scope: Rule['scope'];
  conditions: Rule['conditions'];
  conditionGroups: NonNullable<Rule['conditionGroups']> | null;
  visualQuery: NonNullable<Rule['visualQuery']> | null;
  projectColumns: string[] | null;
  rawKql: string | null;
  graphQuery: NonNullable<Rule['graphQuery']> | null;
  logsQuery: NonNullable<Rule['logsQuery']> | null;
}

export interface ShippedRule {
  id: string;
  pack: string;
  versionScheme: VersionScheme;
  /** Compared with `compareVersions()` under `versionScheme`. */
  version: string;
  releaseNote: string;
  /** The upstream commit this version was synced from, for packs that track one. */
  upstreamRef?: string;
  /** Whether a brand-new install runs it. An existing rule's enabled state is never touched. */
  enabled: boolean;
  definition: RuleDefinition;
}

export interface ShippedCatalogue {
  rules: ShippedRule[];
  /** True when `data/packs/` was listed. False means the packs were not looked at, so a pack rule
   *  missing from `rules` says nothing about whether it was dropped. */
  packsDirRead: boolean;
  /** Pack files that exist but could not be read or have no version: their rules are absent from
   *  `rules` for that reason, not because they were dropped. */
  unreadablePacks: string[];
}

/** A RuleBeat Core definition: a `Rule` plus the version and release note it ships under. */
export interface CoreRuleDefinition extends Rule {
  version: string;
  releaseNote: string;
}

export const CORE_PACK = 'rulebeat-core';

/** JSON text (or an already parsed value) to a value, or allback when it is absent or malformed. */
export function parseMaybeJson<T>(value: unknown, fallback: T): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value as T;
}

/** A stored empty list and an absent one mean the same, so both compare as null. */
export function emptyToNull<T>(value: T[] | null | undefined): T[] | null {
  return value && value.length > 0 ? value : null;
}

/** What a rule on this backend means: Logs rules report activity, the other two report state. */
function kindOfBackend(queryBackend: NonNullable<Rule['queryBackend']>): NonNullable<Rule['kind']> {
  return queryBackend === 'log-analytics' ? 'activity' : 'state';
}

function coreToShipped(r: CoreRuleDefinition, versionScheme: VersionScheme): ShippedRule {
  const queryBackend = r.queryBackend ?? 'resource-graph';
  return {
    id: r.id,
    pack: r.pack ?? CORE_PACK,
    versionScheme,
    version: r.version,
    releaseNote: r.releaseNote,
    enabled: r.enabled,
    definition: {
      name: r.name,
      description: r.description,
      category: r.category,
      severity: r.severity,
      queryBackend,
      kind: r.kind ?? kindOfBackend(queryBackend),
      resourceTypes: r.resourceTypes,
      scope: r.scope,
      conditions: r.conditions,
      conditionGroups: emptyToNull(r.conditionGroups),
      visualQuery: r.visualQuery ?? null,
      projectColumns: emptyToNull(r.projectColumns),
      rawKql: r.rawKql ?? null,
      graphQuery: r.graphQuery ?? null,
      logsQuery: r.logsQuery ?? null,
    },
  };
}

/** The manifest fields the loader reads. A pack's version is one value for the whole pack, taken
 *  from the field its scheme names; the rest of the entry (label, source, licence) is for the UI. */
interface PackManifestEntry {
  versionScheme?: VersionScheme;
  version?: string;
  pinnedRelease?: string;
  pinnedCommit?: string;
  pinnedCommitDate?: string;
}

function readManifest(packsDir: string): Record<string, PackManifestEntry> {
  try {
    return JSON.parse(readFileSync(join(packsDir, 'pack-manifest.json'), 'utf-8')) as Record<string, PackManifestEntry>;
  } catch {
    return {};
  }
}

/** The version a pack ships under, or null when its manifest entry does not declare one. */
function packVersion(entry: PackManifestEntry | undefined): { scheme: VersionScheme; version: string } | null {
  if (!entry?.versionScheme) return null;
  const version = entry.versionScheme === 'semver' ? entry.version
    : entry.versionScheme === 'upstream-release' ? entry.pinnedRelease
    : entry.pinnedCommitDate;
  return version ? { scheme: entry.versionScheme, version } : null;
}

function packRuleToShipped(
  p: Record<string, unknown>,
  packId: string,
  declared: { scheme: VersionScheme; version: string },
  entry: PackManifestEntry,
): ShippedRule {
  const queryBackend = (p.queryBackend as ShippedRule['definition']['queryBackend'] | undefined) ?? 'resource-graph';
  // Pack JSON uses 'rules' (the old name for conditions); read it as conditions for backward compat.
  const conditions = parseMaybeJson<Rule['conditions']>(p.conditions ?? p.rules, []);
  const upstreamRef = entry.pinnedCommit;
  return {
    id: p.id as string,
    pack: (p.pack as string | undefined) ?? packId,
    versionScheme: declared.scheme,
    version: declared.version,
    releaseNote: upstreamRef ? `Synced from upstream commit ${upstreamRef.slice(0, 7)}.` : `Version ${declared.version}.`,
    upstreamRef,
    enabled: Boolean(p.enabled),
    definition: {
      name: p.name as string,
      description: p.description as string,
      category: p.category as string,
      severity: p.severity as string,
      queryBackend,
      kind: kindOfBackend(queryBackend),
      resourceTypes: parseMaybeJson<string[]>(p.resourceTypes, []),
      scope: parseMaybeJson<Rule['scope']>(p.scope, { level: 'resource' }),
      conditions,
      conditionGroups: emptyToNull(parseMaybeJson<Rule['conditionGroups'] | null>(p.conditionGroups, null)),
      visualQuery: parseMaybeJson<Rule['visualQuery'] | null>(p.visualQuery, null) ?? null,
      projectColumns: emptyToNull(parseMaybeJson<string[] | null>(p.projectColumns, null)),
      rawKql: (p.rawKql as string | undefined) ?? null,
      graphQuery: parseMaybeJson<Rule['graphQuery'] | null>(p.graphQuery, null) ?? null,
      logsQuery: parseMaybeJson<Rule['logsQuery'] | null>(p.logsQuery, null) ?? null,
    },
  };
}
/** What this build ships: RuleBeat Core plus every pack file in `<dataDir>/packs`. */
export function loadShippedCatalogue(dataDir: string): ShippedCatalogue {
  const packsDir = join(dataDir, 'packs');
  const manifest = readManifest(packsDir);
  // The manifest is the one source of a pack's scheme, Core's included; Core's own versions live in
  // uiltin-rules.ts, so without a manifest they are read as semver.
  const coreScheme = manifest[CORE_PACK]?.versionScheme ?? 'semver';
  const rules = (BUILTIN_RULES as CoreRuleDefinition[]).map(r => coreToShipped(r, coreScheme));
  if (!existsSync(packsDir)) return { rules, packsDirRead: false, unreadablePacks: [] };

  const unreadablePacks: string[] = [];
  let files: string[];
  try {
    files = readdirSync(packsDir).filter(f => f.endsWith('.json') && f !== 'pack-manifest.json');
  } catch {
    return { rules, packsDirRead: false, unreadablePacks: [] };
  }
  for (const file of files) {
    const packId = basename(file, '.json');
    try {
      const entry = manifest[packId] ?? {};
      const declared = packVersion(entry);
      if (!declared) throw new Error(`pack-manifest.json declares no version for ${packId}`);
      const parsed = JSON.parse(readFileSync(join(packsDir, file), 'utf-8')) as Array<Record<string, unknown>>;
      // Built before any is added, so one bad rule makes the whole pack unreadable rather than half-shipped.
      const shipped = parsed.map(p => packRuleToShipped(p, packId, declared, entry));
      rules.push(...shipped);
    } catch (err) {
      // A malformed or unversioned pack file is skipped, never fatal, and never read as "dropped".
      console.warn(`[rulebeat] skipping pack file ${file}: ${err instanceof Error ? err.message : String(err)}`);
      unreadablePacks.push(packId);
    }
  }
  return { rules, packsDirRead: true, unreadablePacks };
}
