import { rand01 } from './prng';
import { identityColumns, type RuleFixture } from './rule-fixture';

/**
 * Hand-authored fixtures for the 13 `rulebeat-core` rules (`lib/builtin-rules.ts`) — one entry per
 * rule id, matching exactly the columns its own `rawKql` projects. These are worth hand-writing
 * (unlike the generic APRL fixtures) because they're the rules a first-time visitor is most likely
 * to click into, and evidence that looks obviously fake undermines the whole demo. The TLS rule in
 * particular must show `TLS1_0`, never a placeholder — a screenshot of "evidence: unknown" is worse
 * than not having the rule enabled at all.
 */
export const CORE_FIXTURES: RuleFixture[] = [
  {
    ruleId: '7a25444f-90c1-4c4e-b6dc-3076a857dfa8', // Unattached Managed Disk
    resourceTypes: ['microsoft.compute/disks'],
    severity: 'medium',
    buildRow: r => ({
      ...identityColumns(r),
      diskState: 'Unattached',
      diskSizeGB: 32 + Math.floor(rand01(`disk-size::${r.id}`) * 480),
    }),
  },
  {
    ruleId: '75e36a3a-4c4c-4ca2-b7d9-624d1350cb7a', // Unattached Network Interface
    resourceTypes: ['microsoft.network/networkinterfaces'],
    severity: 'low',
    buildRow: r => identityColumns(r),
  },
  {
    ruleId: '4bc476d2-2030-4c24-9d67-9b434cf5d80b', // Unassigned Public IP Address
    resourceTypes: ['microsoft.network/publicipaddresses'],
    severity: 'medium',
    buildRow: r => ({ ...identityColumns(r), sku: 'Standard' }),
  },
  {
    ruleId: 'c4ecd795-6e77-4038-9382-9dab237d4953', // Empty Network Security Group
    resourceTypes: ['microsoft.network/networksecuritygroups'],
    severity: 'low',
    buildRow: r => identityColumns(r),
  },
  {
    ruleId: '8c6c0195-ccb1-41c6-aeb2-1de96df20cc5', // Stale Disk Snapshot
    resourceTypes: ['microsoft.compute/snapshots'],
    severity: 'low',
    buildRow: r => {
      const daysAgo = 35 + Math.floor(rand01(`snap-age::${r.id}`) * 90);
      return {
        ...identityColumns(r),
        timeCreated: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
        diskSizeGB: 16 + Math.floor(rand01(`snap-size::${r.id}`) * 200),
      };
    },
  },
  {
    ruleId: '9c6d51b9-5bf9-480c-9932-555f339f5e95', // Storage Account Allows HTTP Traffic
    resourceTypes: ['microsoft.storage/storageaccounts'],
    severity: 'medium',
    buildRow: r => ({ ...identityColumns(r), supportsHttpsTrafficOnly: false }),
  },
  {
    ruleId: '18d9a934-c953-4833-ae75-9f169688f360', // Storage Account Public Blob Access Enabled
    resourceTypes: ['microsoft.storage/storageaccounts'],
    severity: 'high',
    buildRow: r => identityColumns(r),
  },
  {
    ruleId: '7a6e836a-11eb-491b-b362-c9751d15b76c', // Storage Account TLS Version Below 1.2
    resourceTypes: ['microsoft.storage/storageaccounts'],
    severity: 'medium',
    buildRow: r => ({ ...identityColumns(r), minimumTlsVersion: 'TLS1_0' }),
  },
  {
    ruleId: '3bf741b6-a340-41f8-bfb2-c094a85ef575', // Key Vault Soft Delete Disabled
    resourceTypes: ['microsoft.keyvault/vaults'],
    severity: 'high',
    buildRow: r => identityColumns(r),
  },
  {
    ruleId: 'b138e30b-6d3e-4464-a58e-0b46d1d6be21', // Key Vault Purge Protection Disabled
    resourceTypes: ['microsoft.keyvault/vaults'],
    severity: 'medium',
    buildRow: r => identityColumns(r),
  },
  {
    ruleId: 'db175338-5c33-484a-bcf5-24f20e3bc60c', // Missing Environment Tag
    resourceTypes: [],
    severity: 'medium',
    buildRow: r => identityColumns(r),
  },
  {
    ruleId: 'ba4b3116-7403-4b13-95ae-283272f763c5', // Missing Owner Tag
    resourceTypes: [],
    severity: 'medium',
    buildRow: r => identityColumns(r),
  },
  {
    ruleId: '74773874-6c41-47b7-b33b-4d6feb8e1031', // Missing CostCenter Tag
    resourceTypes: [],
    severity: 'medium',
    buildRow: r => identityColumns(r),
  },
];

export const CORE_RULE_IDS = CORE_FIXTURES.map(f => f.ruleId);
