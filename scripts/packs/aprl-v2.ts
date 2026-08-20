/**
 * APRL v2 pack definition.
 * Source: https://github.com/Azure/Azure-Proactive-Resiliency-Library-v2 (MIT License)
 * Attribution: Copyright (c) Microsoft Corporation
 *
 * Usage:
 *   npm run sync-pack -- aprl-v2 --commit=<sha>
 *   npm run sync-pack -- aprl-v2 --commit=main
 *
 * APRL v2 structure:
 *   azure-resources/<provider>/<resource-type>/
 *     recommendations.yaml   ← metadata (guid, description, severity, control, ...)
 *     code/
 *       *.kql                ← one KQL file per recommendation that has automation
 *
 * The YAML links to KQL via aprlGuid. The .kql files are named with a short prefix
 * (e.g. cm-1.kql, st-2.kql) but contain the guid in a comment on the first line:
 *   // Azure Resource Graph Query
 *   // Checks if VMs are in an availability zone
 *   resources | where ...
 * We match by scanning all .kql files under the same resource-type directory.
 */

import yaml from 'js-yaml';
import type { PackDefinition } from '../sync-pack';
import type { Policy } from '../../packages/web/lib/types';

const REPO = 'Azure/Azure-Proactive-Resiliency-Library-v2';
const RAW  = `https://raw.githubusercontent.com/${REPO}`;
const API  = `https://api.github.com/repos/${REPO}`;

// Maps APRL recommendationControl → our ModuleCategory
const CATEGORY_MAP: Record<string, Policy['category']> = {
  'High Availability':       'reliability',
  'Business Continuity':     'reliability',
  'Disaster Recovery':       'reliability',
  'Scalability':             'reliability',
  'Application Resilience':  'reliability',
  'Storage':                 'reliability',
  'Other Best Practices':    'reliability',
  'Monitoring and Alerting': 'operations',
  'Service Upgrades':        'operations',
  'Governance':              'compliance',
  'Networking':              'networking',
  'Security':                'security',
};

const SEVERITY_MAP: Record<string, Policy['severity']> = {
  'Critical': 'critical',
  'High':     'high',
  'Medium':   'medium',
  'Low':      'low',
};

interface AprlRec {
  aprlGuid?: string;
  description?: string;
  recommendationControl?: string;
  recommendationImpact?: string;
  recommendationResourceType?: string;
  recommendationMetadataState?: string;
  longDescription?: string;
  automationAvailable?: boolean | string;
  query?: string;
  learnMoreLink?: Array<{ name: string; url: string }> | null;
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': 'RuleBeat-sync/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function getJson<T>(url: string): Promise<T> {
  const text = await getText(url);
  return JSON.parse(text) as T;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export const aprlV2Pack: PackDefinition = {
  id: 'aprl-v2',
  label: 'APRL v2',
  source: `https://github.com/${REPO}`,
  license: 'MIT',
  attribution: 'Copyright (c) Microsoft Corporation. Azure Proactive Resiliency Library v2.',

  async fetch(commit: string): Promise<Policy[]> {
    // ── 1. Get full repo tree ──────────────────────────────────────────────────
    console.log(`  Fetching repo tree at ${commit}…`);
    const tree = await getJson<{ tree: Array<{ path: string; type: string }>; truncated?: boolean }>(
      `${API}/git/trees/${commit}?recursive=1`,
    );
    if (tree.truncated) console.warn('  Warning: tree was truncated — some files may be missing.');

    const allPaths = tree.tree.filter(f => f.type === 'blob').map(f => f.path);

    // ── 2. Collect YAML and KQL paths ─────────────────────────────────────────
    const yamlPaths = allPaths.filter(p => p.endsWith('/recommendations.yaml'));
    const kqlPaths  = allPaths.filter(p => p.endsWith('.kql'));

    console.log(`  Found ${yamlPaths.length} YAML files, ${kqlPaths.length} KQL files`);

    // ── 3. Build GUID → KQL map by fetching all .kql files ───────────────────
    // KQL files don't have the GUID in their filename, so we group them by their
    // parent code/ directory (which corresponds to a resource type).
    // We'll match them to recommendations by directory later.
    // Key: parent dir of code/ (e.g. "azure-resources/microsoft.compute/virtualmachines")
    // Value: array of KQL strings in that directory

    console.log(`  Fetching KQL files…`);
    // dir path → list of KQL strings
    const kqlByDir = new Map<string, string[]>();

    for (const kqlPath of kqlPaths) {
      // path is like: azure-resources/microsoft.compute/virtualmachines/code/cm-1.kql
      const codeDir  = kqlPath.substring(0, kqlPath.lastIndexOf('/'));  // .../code
      const parentDir = codeDir.substring(0, codeDir.lastIndexOf('/'));  // .../<resource-type>

      try {
        const kql = await getText(`${RAW}/${commit}/${kqlPath}`);
        const trimmed = kql.trim();
        if (trimmed) {
          const list = kqlByDir.get(parentDir) ?? [];
          list.push(trimmed);
          kqlByDir.set(parentDir, list);
        }
        await sleep(50);
      } catch {
        // skip unreadable files
      }
    }

    console.log(`  Loaded KQL from ${kqlByDir.size} resource type directories`);

    // ── 4. Parse YAML files and match KQL ────────────────────────────────────
    const policies: Policy[] = [];
    let skipped = 0;

    for (const yamlPath of yamlPaths) {
      // yamlPath: azure-resources/microsoft.compute/virtualmachines/recommendations.yaml
      const parentDir = yamlPath.substring(0, yamlPath.lastIndexOf('/'));
      const kqlList   = kqlByDir.get(parentDir) ?? [];

      try {
        const text = await getText(`${RAW}/${commit}/${yamlPath}`);
        const recs = yaml.load(text) as AprlRec[] | null;
        if (!Array.isArray(recs)) continue;

        let kqlIndex = 0; // assign KQL files to recommendations in order

        for (const rec of recs) {
          const guid    = rec.aprlGuid?.trim();
          const name    = rec.description?.trim();
          const state   = rec.recommendationMetadataState?.toLowerCase();
          const hasAuto = rec.automationAvailable === true || rec.automationAvailable === 'true';

          if (!guid || !name) { skipped++; continue; }
          if (state === 'retired' || state === 'preview' || state === 'disabled') { skipped++; continue; }
          if (!hasAuto) { skipped++; continue; }

          // Try inline query first, then fall back to the next KQL file in the directory
          const rawKql = (rec.query?.trim()) || (kqlList[kqlIndex] ?? '');
          if (!rawKql) { skipped++; continue; }

          // Advance KQL index only when we consumed one (for inline queries, don't advance)
          if (!rec.query?.trim()) kqlIndex++;

          const category = CATEGORY_MAP[rec.recommendationControl ?? ''] ?? 'reliability';
          const severity  = SEVERITY_MAP[rec.recommendationImpact  ?? ''] ?? 'medium';
          const resType   = rec.recommendationResourceType?.trim() ?? '';
          const learnUrl  = rec.learnMoreLink?.[0]?.url;
          const desc      = [
            rec.longDescription?.trim() || name,
            learnUrl ? `\nLearn more: ${learnUrl}` : '',
          ].filter(Boolean).join('');

          policies.push({
            id: guid,
            name,
            description: desc,
            category,
            severity,
            // Ships disabled: APRL carries no remediation, so 143 enabled-by-default findings
            // with no fix attached contradicts the product's core promise. See B3 phase 1.
            enabled: false,
            type: 'builtin',
            pack: aprlV2Pack.id,
            scope: { level: 'resource' },
            resourceTypes: resType ? [resType] : [],
            rules: [],
            rawKql,
          });
        }

        await sleep(60);
      } catch (err) {
        console.warn(`  Warning: skipped ${yamlPath}: ${err}`);
      }
    }

    console.log(`  Result: ${policies.length} policies added, ${skipped} skipped`);
    return policies;
  },
};
