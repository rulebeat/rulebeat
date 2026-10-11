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
 *       <aprlGuid>.kql       ← the query of the recommendation with that guid
 *
 * Each .kql file is named after the aprlGuid of its recommendation, and that name is the only link
 * between the two (lib/aprl-pairing.ts). A file whose name is not a guid is reported and paired
 * with nothing; a recommendation with no file named after it has no query and is not shipped, and
 * neither is one whose query is only comments, such as `// under-development` (#222).
 * Files are never handed out by position: a skipped recommendation uses no file, so a positional
 * pairing would move every later recommendation onto another one's query (#221).
 */

import yaml from 'js-yaml';
import type { PackDefinition } from '../sync-pack';
import type { Policy } from '../../packages/web/lib/types';
import { pairRecommendations, type AprlRecommendation } from '../../packages/web/lib/aprl-pairing';

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
    // A truncated tree lists only part of the repo; syncing from it would silently drop recommendations.
    if (tree.truncated) throw new Error('the repo tree was truncated, so its file list is incomplete');

    const allPaths = tree.tree.filter(f => f.type === 'blob').map(f => f.path);

    // ── 2. Collect YAML and KQL paths ─────────────────────────────────────────
    const yamlPaths = allPaths.filter(p => p.endsWith('/recommendations.yaml'));
    const kqlPaths  = allPaths.filter(p => p.endsWith('.kql'));

    console.log(`  Found ${yamlPaths.length} YAML files, ${kqlPaths.length} KQL files`);

    // ── 3. Fetch every .kql file, grouped by resource-type directory ─────────
    // A file that cannot be fetched fails the sync: it must never pass for "no file upstream".
    console.log(`  Fetching KQL files…`);
    // resource-type dir → (file path → text)
    const kqlByDir = new Map<string, Record<string, string>>();

    for (const kqlPath of kqlPaths) {
      // path is like: azure-resources/microsoft.compute/virtualmachines/code/<aprlGuid>.kql
      const codeDir   = kqlPath.substring(0, kqlPath.lastIndexOf('/'));  // .../code
      const parentDir = codeDir.substring(0, codeDir.lastIndexOf('/'));  // .../<resource-type>

      let text: string;
      try {
        text = await getText(`${RAW}/${commit}/${kqlPath}`);
      } catch (err) {
        throw new Error(`could not fetch ${kqlPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const files = kqlByDir.get(parentDir) ?? {};
      files[kqlPath] = text;
      kqlByDir.set(parentDir, files);
      await sleep(50);
    }

    console.log(`  Loaded KQL from ${kqlByDir.size} resource type directories`);

    // ── 4. Parse YAML files and pair each recommendation with its own .kql ──
    const policies: Policy[] = [];
    let skipped = 0;
    const unpairedFiles: string[] = [];

    for (const yamlPath of yamlPaths) {
      // yamlPath: azure-resources/microsoft.compute/virtualmachines/recommendations.yaml
      const parentDir = yamlPath.substring(0, yamlPath.lastIndexOf('/'));

      try {
        const text = await getText(`${RAW}/${commit}/${yamlPath}`);
        const recs = yaml.load(text) as AprlRecommendation[] | null;
        if (!Array.isArray(recs)) continue;

        const pairing = pairRecommendations(recs, kqlByDir.get(parentDir) ?? {});
        skipped += pairing.skipped;
        unpairedFiles.push(...pairing.unpairedFiles);

        for (const { rec, guid, name, rawKql } of pairing.selected) {
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

    for (const path of unpairedFiles) {
      console.warn(`  Warning: ${path} is not named after a recommendation guid, so it is paired with nothing`);
    }
    console.log(`  Result: ${policies.length} policies added, ${skipped} skipped, ${unpairedFiles.length} .kql files not named by guid`);
    return policies;
  },
};
