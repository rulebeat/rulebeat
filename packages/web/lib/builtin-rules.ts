import type { Rule } from '@rulebeat/core';

const NON_TAGGABLE_FILTER = `type !in~ (
    'microsoft.network/virtualnetworks/subnets',
    'microsoft.network/networksecuritygroups/securityrules',
    'microsoft.network/routetables/routes',
    'microsoft.compute/virtualmachinescalesets/virtualmachines',
    'microsoft.resources/deployments',
    'microsoft.resources/deploymentscripts'
  )`;

// ── Cost / Orphaned ───────────────────────────────────────────────────────────

const COST_RULES: Rule[] = [
  {
    id: '7a25444f-90c1-4c4e-b6dc-3076a857dfa8',
    type: 'builtin',
    pack: 'rulebeat-core',
    name: 'Unattached Managed Disk',
    description: 'Managed disks not attached to any VM are still billed. Delete or snapshot them if no longer needed.',
    category: 'cost',
    severity: 'medium',
    enabled: true,
    scope: { level: 'resource' },
    resourceTypes: ['microsoft.compute/disks'],
    conditions: [],
    rawKql: `Resources
| where type =~ 'microsoft.compute/disks'
| where properties.diskState =~ 'Unattached'
| project id, name, type, location, resourceGroup, subscriptionId, diskState=properties.diskState, diskSizeGB=properties.diskSizeGB`,
  },
  {
    id: '75e36a3a-4c4c-4ca2-b7d9-624d1350cb7a',
    type: 'builtin',
    pack: 'rulebeat-core',
    name: 'Unattached Network Interface',
    description: 'Network interfaces not associated with any VM add clutter and can confuse network troubleshooting.',
    category: 'cost',
    severity: 'low',
    enabled: true,
    scope: { level: 'resource' },
    resourceTypes: ['microsoft.network/networkinterfaces'],
    conditions: [],
    rawKql: `Resources
| where type =~ 'microsoft.network/networkinterfaces'
| where isnull(properties.virtualMachine)
| project id, name, type, location, resourceGroup, subscriptionId`,
  },
  {
    id: '4bc476d2-2030-4c24-9d67-9b434cf5d80b',
    type: 'builtin',
    pack: 'rulebeat-core',
    name: 'Unassigned Public IP Address',
    description: 'Public IPs not associated with any resource still incur charges (Standard SKU ~$3.65/mo) and increase attack surface.',
    category: 'cost',
    severity: 'medium',
    enabled: true,
    scope: { level: 'resource' },
    resourceTypes: ['microsoft.network/publicipaddresses'],
    conditions: [],
    rawKql: `Resources
| where type =~ 'microsoft.network/publicipaddresses'
| where isnull(properties.ipConfiguration)
| project id, name, type, location, resourceGroup, subscriptionId, sku=properties.sku.name`,
  },
  {
    id: 'c4ecd795-6e77-4038-9382-9dab237d4953',
    type: 'builtin',
    pack: 'rulebeat-core',
    name: 'Empty Network Security Group',
    description: 'NSGs with no associated NICs or subnets serve no purpose and add noise to security reviews.',
    category: 'cost',
    severity: 'low',
    enabled: true,
    scope: { level: 'resource' },
    resourceTypes: ['microsoft.network/networksecuritygroups'],
    conditions: [],
    rawKql: `Resources
| where type =~ 'microsoft.network/networksecuritygroups'
| where (isnull(properties.networkInterfaces) or array_length(properties.networkInterfaces) == 0)
| where (isnull(properties.subnets) or array_length(properties.subnets) == 0)
| project id, name, type, location, resourceGroup, subscriptionId`,
  },
  {
    id: '8c6c0195-ccb1-41c6-aeb2-1de96df20cc5',
    type: 'builtin',
    pack: 'rulebeat-core',
    name: 'Stale Disk Snapshot',
    description: 'Disk snapshots older than 30 days are candidates for cleanup. Review whether they are still needed as recovery points.',
    category: 'cost',
    severity: 'low',
    enabled: true,
    scope: { level: 'resource' },
    resourceTypes: ['microsoft.compute/snapshots'],
    conditions: [],
    rawKql: `Resources
| where type =~ 'microsoft.compute/snapshots'
| where todatetime(properties.timeCreated) < ago(30d)
| project id, name, type, location, resourceGroup, subscriptionId, timeCreated=properties.timeCreated, diskSizeGB=properties.diskSizeGB`,
  },
];

// ── Security / Resource Standards ────────────────────────────────────────────

const SECURITY_RULES: Rule[] = [
  {
    id: '9c6d51b9-5bf9-480c-9932-555f339f5e95',
    type: 'builtin',
    pack: 'rulebeat-core',
    name: 'Storage Account Allows HTTP Traffic',
    description: 'Allowing HTTP traffic to storage accounts exposes data in transit. All access should be restricted to HTTPS.',
    category: 'security',
    severity: 'medium',
    enabled: true,
    scope: { level: 'resource' },
    resourceTypes: ['microsoft.storage/storageaccounts'],
    conditions: [],
    rawKql: `Resources
| where type =~ 'microsoft.storage/storageaccounts'
| where properties.supportsHttpsTrafficOnly != true
| project id, name, type, location, resourceGroup, subscriptionId, supportsHttpsTrafficOnly=properties.supportsHttpsTrafficOnly`,
  },
  {
    id: '18d9a934-c953-4833-ae75-9f169688f360',
    type: 'builtin',
    pack: 'rulebeat-core',
    name: 'Storage Account Public Blob Access Enabled',
    description: 'Anonymous public read access allows unauthenticated data access. Disable unless explicitly required for public content.',
    category: 'security',
    severity: 'high',
    enabled: true,
    scope: { level: 'resource' },
    resourceTypes: ['microsoft.storage/storageaccounts'],
    conditions: [],
    rawKql: `Resources
| where type =~ 'microsoft.storage/storageaccounts'
| where properties.allowBlobPublicAccess == true
| project id, name, type, location, resourceGroup, subscriptionId`,
  },
  {
    id: '7a6e836a-11eb-491b-b362-c9751d15b76c',
    type: 'builtin',
    pack: 'rulebeat-core',
    name: 'Storage Account TLS Version Below 1.2',
    description: 'TLS versions below 1.2 have known vulnerabilities. All storage accounts should enforce a minimum of TLS 1.2.',
    category: 'security',
    severity: 'medium',
    enabled: true,
    scope: { level: 'resource' },
    resourceTypes: ['microsoft.storage/storageaccounts'],
    conditions: [],
    rawKql: `Resources
| where type =~ 'microsoft.storage/storageaccounts'
| where isnotempty(properties.minimumTlsVersion)
| where properties.minimumTlsVersion !in ('TLS1_2', 'TLS1_3')
| project id, name, type, location, resourceGroup, subscriptionId, minimumTlsVersion=properties.minimumTlsVersion`,
  },
  {
    id: '3bf741b6-a340-41f8-bfb2-c094a85ef575',
    type: 'builtin',
    pack: 'rulebeat-core',
    name: 'Key Vault Soft Delete Disabled',
    description: 'Without soft delete, accidentally deleted Key Vault objects are permanently gone. Soft delete provides a recovery window.',
    category: 'security',
    severity: 'high',
    enabled: true,
    scope: { level: 'resource' },
    resourceTypes: ['microsoft.keyvault/vaults'],
    conditions: [],
    rawKql: `Resources
| where type =~ 'microsoft.keyvault/vaults'
| where properties.enableSoftDelete != true
| project id, name, type, location, resourceGroup, subscriptionId`,
  },
  {
    id: 'b138e30b-6d3e-4464-a58e-0b46d1d6be21',
    type: 'builtin',
    pack: 'rulebeat-core',
    name: 'Key Vault Purge Protection Disabled',
    description: 'Without purge protection, soft-deleted Key Vault objects can still be permanently deleted before the retention period ends.',
    category: 'security',
    severity: 'medium',
    enabled: true,
    scope: { level: 'resource' },
    resourceTypes: ['microsoft.keyvault/vaults'],
    conditions: [],
    rawKql: `Resources
| where type =~ 'microsoft.keyvault/vaults'
| where properties.enablePurgeProtection != true
| project id, name, type, location, resourceGroup, subscriptionId`,
  },
];

// ── Compliance / Tag Checks ───────────────────────────────────────────────────
// Disabled by default — tag names are org-specific. Edit the KQL to match your tag names.

const COMPLIANCE_RULES: Rule[] = [
  {
    id: 'db175338-5c33-484a-bcf5-24f20e3bc60c',
    type: 'builtin',
    pack: 'rulebeat-core',
    name: 'Missing Environment Tag',
    description: "Resources missing the 'Environment' tag cannot be attributed to a deployment environment (dev/test/prod). Edit this rule's KQL to match your tag name.",
    category: 'compliance',
    severity: 'medium',
    enabled: false,
    scope: { level: 'resource' },
    resourceTypes: [],
    conditions: [],
    rawKql: `Resources
| where ${NON_TAGGABLE_FILTER}
| where isempty(tostring(tags['Environment'])) or isnull(tags['Environment'])
| project id, name, type, location, resourceGroup, subscriptionId`,
  },
  {
    id: 'ba4b3116-7403-4b13-95ae-283272f763c5',
    type: 'builtin',
    pack: 'rulebeat-core',
    name: 'Missing Owner Tag',
    description: "Resources missing the 'Owner' tag have no accountable team or person. Edit this rule's KQL to match your tag name.",
    category: 'compliance',
    severity: 'medium',
    enabled: false,
    scope: { level: 'resource' },
    resourceTypes: [],
    conditions: [],
    rawKql: `Resources
| where ${NON_TAGGABLE_FILTER}
| where isempty(tostring(tags['Owner'])) or isnull(tags['Owner'])
| project id, name, type, location, resourceGroup, subscriptionId`,
  },
  {
    id: '74773874-6c41-47b7-b33b-4d6feb8e1031',
    type: 'builtin',
    pack: 'rulebeat-core',
    name: 'Missing CostCenter Tag',
    description: "Resources missing the 'CostCenter' tag cannot be attributed to a cost center for chargeback. Edit this rule's KQL to match your tag name.",
    category: 'compliance',
    severity: 'medium',
    enabled: false,
    scope: { level: 'resource' },
    resourceTypes: [],
    conditions: [],
    rawKql: `Resources
| where ${NON_TAGGABLE_FILTER}
| where isempty(tostring(tags['CostCenter'])) or isnull(tags['CostCenter'])
| project id, name, type, location, resourceGroup, subscriptionId`,
  },
];

// ── Identity / App Credentials ───────────────────────────────────────────────
// Microsoft Graph-backed, not Resource Graph: runGraphRules() (packages/core/src/engine/graph-runner.ts)
// evaluates these through the generic per-item expand mechanism (spec 032), not via KQL and not
// through any rule-specific code path. No resourceTypes — an app registration's credentials
// aren't ARM resources at all. `description` doubles as both the finding's description and its
// recommendation (graph-runner.ts reuses the one field for both, matching how the ARG-backed
// runner.ts already treats a rule's description as its own recommendation) — keep it written as
// actionable guidance, not just a problem statement.

const IDENTITY_RULES: Rule[] = [
  {
    id: 'cred:app-secret-expiring',
    type: 'builtin',
    pack: 'rulebeat-core',
    name: 'App Registration Secret Expiring',
    description: 'A client secret on an app registration is expiring soon. Rotate the secret and update any applications that use it before it expires, or whatever depends on it will break without warning.',
    category: 'identity',
    severity: 'medium',
    enabled: true,
    scope: { level: 'resource' },
    resourceTypes: [],
    conditions: [],
    queryBackend: 'microsoft-graph',
    graphQuery: {
      path: 'applications',
      expand: {
        arrayField: 'passwordCredentials',
        dateField: 'endDateTime',
        itemIdField: 'keyId',
        resourceType: 'microsoft.aad/applications/secrets',
        bands: [
          { maxDays: 7, severity: 'critical' },
          { maxDays: 14, severity: 'high' },
          { maxDays: 30, severity: 'medium' },
        ],
      },
    },
  },
  {
    id: 'cred:app-cert-expiring',
    type: 'builtin',
    pack: 'rulebeat-core',
    name: 'App Registration Certificate Expiring',
    description: 'A certificate credential on an app registration is expiring soon. Upload a new certificate and update the application configuration before the current one expires, or whatever depends on it will break without warning.',
    category: 'identity',
    severity: 'medium',
    enabled: true,
    scope: { level: 'resource' },
    resourceTypes: [],
    conditions: [],
    queryBackend: 'microsoft-graph',
    graphQuery: {
      path: 'applications',
      expand: {
        arrayField: 'keyCredentials',
        dateField: 'endDateTime',
        itemIdField: 'keyId',
        resourceType: 'microsoft.aad/applications/certificates',
        bands: [
          { maxDays: 7, severity: 'critical' },
          { maxDays: 14, severity: 'high' },
          { maxDays: 30, severity: 'medium' },
        ],
      },
    },
  },
];

export const BUILTIN_RULES: Rule[] = [
  ...COST_RULES,
  ...SECURITY_RULES,
  ...COMPLIANCE_RULES,
  ...IDENTITY_RULES,
];
