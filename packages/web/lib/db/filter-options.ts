/**
 * The one options read behind the shared filter component (#388), on one read transaction so the categories,
 * rules, tree and placements are one moment of the database. See `lib/filter-options.ts` for what it holds.
 *
 * The rule, tag, category and source lists are the same for everyone, since a rule's definition is. The Scope
 * tree and the placements are the viewer's: the tree is the stored copy of the management group tree limited to
 * what they hold (never a live listing, so this read never reaches Azure), and the placements are read through
 * the access filter, so a value is on offer only when the viewer has a finding to see there.
 */
import { asc } from 'drizzle-orm';
import type { Access } from '../access-model';
import { inReadTransaction, many, type DbHandle } from './exec';
import {
  categories as categoriesTable, findings as findingsTable, managementGroupHierarchy as hierarchyTable, rules as rulesTable,
} from './tables';
import { accessFilterSql } from './access-filter';
import { getHierarchyStatusOn } from './management-group-hierarchy';
import { ruleTagsOf } from '../rules';
import { CORE_PACK } from '../shipped-catalogue';
import { SEVERITY_ORDER } from '../severity';
import { subscriptionValue } from '../placement';
import { buildScopeOptions } from '../scope-options';
import { FIXED_SOURCES, type FilterOptions, type SourceOption } from '../filter-options';
import { packSourceLabel, type PackManifestLabels } from '../pack-labels';
import type { TreeNode } from '../management-group-tree';
import type { ScopeFunnelPlacements } from '../scope-funnels';
import packManifest from '@/data/packs/pack-manifest.json';

const compareNames = (a: string, b: string) => a.localeCompare(b);

async function readNodes(tx: DbHandle): Promise<TreeNode[]> {
  const rows = await many(tx.select().from(hierarchyTable));
  return rows.flatMap((row): TreeNode[] => (
    row.kind === 'managementGroup' || row.kind === 'subscription'
      ? [{ id: row.nodeId, kind: row.kind, name: row.displayName, parentId: row.parentId }]
      : []
  ));
}

/** Where the findings `access` sees are placed: the subscriptions (the Directory as its reserved value) and the
 *  resource groups, each with its subscription. A finding placed above a resource group adds no group. */
async function readPlacements(tx: DbHandle, access: Access): Promise<ScopeFunnelPlacements> {
  const t = findingsTable;
  const rows = await many(tx.selectDistinct({ placement: t.placement, subscriptionId: t.subscriptionId, resourceGroup: t.resourceGroup })
    .from(t).where(accessFilterSql(access)));
  const subscriptions = new Set<string>();
  const groups = new Map<string, { subscription: string; name: string }>();
  for (const row of rows) {
    const subscription = subscriptionValue(row);
    if (subscription) subscriptions.add(subscription);
    if (row.resourceGroup && row.subscriptionId && (row.placement === 'resource' || row.placement === 'workspace')) {
      groups.set(`${row.subscriptionId.toLowerCase()}/${row.resourceGroup.toLowerCase()}`, { subscription: row.subscriptionId, name: row.resourceGroup });
    }
  }
  return { subscriptions: [...subscriptions].sort(compareNames), resourceGroups: [...groups.values()] };
}

async function readRules(tx: DbHandle, labels: PackManifestLabels): Promise<Pick<FilterOptions, 'rules' | 'tags' | 'sources'>> {
  const rows = await many(tx.select({
    id: rulesTable.id, name: rulesTable.name, category: rulesTable.category, enabled: rulesTable.enabled, type: rulesTable.type,
    pack: rulesTable.pack, tags: rulesTable.tags, group: rulesTable.group, retiredAt: rulesTable.retiredAt,
  }).from(rulesTable));
  const tags = new Set<string>();
  const packs = new Set<string>();
  for (const row of rows) {
    for (const tag of ruleTagsOf(row) ?? []) tags.add(tag);
    if (row.type === 'builtin') packs.add(row.pack ?? CORE_PACK);
  }
  const packOptions = [...packs]
    .map((value): SourceOption => ({ value, label: packSourceLabel(value, labels) }))
    // RuleBeat Core leads, then the other packs by label.
    .sort((a, b) => (a.value === CORE_PACK ? -1 : b.value === CORE_PACK ? 1 : compareNames(a.label, b.label)));
  return {
    rules: rows
      .map(r => ({ id: r.id, name: r.name, category: r.category, disabled: !r.enabled, retired: r.retiredAt !== null }))
      .sort((a, b) => compareNames(a.name, b.name) || compareNames(a.id, b.id)),
    tags: [...tags].sort(compareNames),
    sources: [...packOptions, ...FIXED_SOURCES],
  };
}

/** The options for `access`. `labels` is the pack manifest, injectable so a test can give a pack another label. */
export function readFilterOptions(access: Access, labels: PackManifestLabels = packManifest as PackManifestLabels): Promise<FilterOptions> {
  return inReadTransaction(async (tx) => {
    const categoryRows = await many(tx.select().from(categoriesTable).orderBy(asc(categoriesTable.sortOrder)));
    const placements = await readPlacements(tx, access);
    const status = await getHierarchyStatusOn(tx);
    return {
      categories: categoryRows.map(c => ({ id: c.id, label: c.label, color: c.color ?? undefined })),
      ...(await readRules(tx, labels)),
      severities: [...SEVERITY_ORDER],
      scopes: buildScopeOptions(access, await readNodes(tx), status, placements.resourceGroups),
      placements,
    };
  });
}

