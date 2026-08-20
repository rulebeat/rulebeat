import { DEMO_SUBSCRIPTIONS } from '../../lib/demo-fixtures';
import { mulberry32, pick, pickWeighted, shuffle } from './prng';

const ESTATE_SEED = 0xc0ffee;

export interface EstateResource {
  id: string;
  name: string;
  type: string; // lowercase, e.g. 'microsoft.compute/disks'
  location: string;
  resourceGroup: string;
  subscriptionId: string;
  tags: Record<string, string> | null;
}

export interface Estate {
  resources: EstateResource[];
  byId: Map<string, EstateResource>;
}

/** Every resource type the estate ever generates. Also the allowlist the generator uses to decide
 *  which APRL rules are answerable — a rule whose resourceTypes aren't all in here has nothing in
 *  the estate to match, so it's never a candidate for enabling (see aprl-fixtures.ts). */
export const TYPE_META: Record<string, { provider: string; segment: string }> = {
  'microsoft.compute/disks': { provider: 'Microsoft.Compute', segment: 'disks' },
  'microsoft.compute/snapshots': { provider: 'Microsoft.Compute', segment: 'snapshots' },
  'microsoft.compute/virtualmachines': { provider: 'Microsoft.Compute', segment: 'virtualMachines' },
  'microsoft.storage/storageaccounts': { provider: 'Microsoft.Storage', segment: 'storageAccounts' },
  'microsoft.network/networkinterfaces': { provider: 'Microsoft.Network', segment: 'networkInterfaces' },
  'microsoft.network/publicipaddresses': { provider: 'Microsoft.Network', segment: 'publicIPAddresses' },
  'microsoft.network/networksecuritygroups': { provider: 'Microsoft.Network', segment: 'networkSecurityGroups' },
  'microsoft.network/virtualnetworks': { provider: 'Microsoft.Network', segment: 'virtualNetworks' },
  'microsoft.keyvault/vaults': { provider: 'Microsoft.KeyVault', segment: 'vaults' },
  'microsoft.sql/servers': { provider: 'Microsoft.Sql', segment: 'servers' },
  'microsoft.web/sites': { provider: 'Microsoft.Web', segment: 'sites' },
  'microsoft.containerregistry/registries': { provider: 'Microsoft.ContainerRegistry', segment: 'registries' },
};

const TYPE_WEIGHTS: Array<{ value: string; weight: number }> = [
  { value: 'microsoft.storage/storageaccounts', weight: 15 },
  { value: 'microsoft.compute/disks', weight: 12 },
  { value: 'microsoft.compute/virtualmachines', weight: 12 },
  { value: 'microsoft.network/networkinterfaces', weight: 12 },
  { value: 'microsoft.network/publicipaddresses', weight: 8 },
  { value: 'microsoft.network/networksecuritygroups', weight: 8 },
  { value: 'microsoft.network/virtualnetworks', weight: 5 },
  { value: 'microsoft.compute/snapshots', weight: 6 },
  { value: 'microsoft.keyvault/vaults', weight: 6 },
  { value: 'microsoft.sql/servers', weight: 6 },
  { value: 'microsoft.web/sites', weight: 6 },
  { value: 'microsoft.containerregistry/registries', weight: 4 },
];

const REGIONS = ['eastus', 'westeurope', 'southeastasia', 'uksouth'];
const WORKLOADS = ['platform', 'data', 'shared', 'web', 'core', 'network', 'identity', 'analytics', 'checkout', 'billing'];
const NAME_WORDS = ['checkout', 'billing', 'auth', 'search', 'ingest', 'api', 'worker', 'portal', 'edge', 'cache', 'queue', 'gateway'];
const OWNERS = ['platform-team', 'data-team', 'web-team', 'sre-team', 'security-team'];

function resourceGroupsFor(subName: string, rng: () => number): string[] {
  const envBias = subName.includes('Dev') ? 'dev' : subName.includes('Data') ? 'data' : subName.includes('Shared') ? 'shared' : 'prod';
  return shuffle(WORKLOADS, rng).slice(0, 8).map(w => `rg-${w}-${envBias}`);
}

function nameFor(type: string, rg: string, index: number, rng: () => number): string {
  const word = pick(NAME_WORDS, rng);
  switch (type) {
    case 'microsoft.compute/virtualmachines': return `vm-${word}-${index}`;
    case 'microsoft.compute/disks': return `disk-${word}-${index}`;
    case 'microsoft.compute/snapshots': return `snap-${word}-${index}`;
    case 'microsoft.storage/storageaccounts': return `st${word}${index}${rg.replace(/[^a-z0-9]/g, '')}`.toLowerCase().slice(0, 24);
    case 'microsoft.network/networkinterfaces': return `nic-${word}-${index}`;
    case 'microsoft.network/publicipaddresses': return `pip-${word}-${index}`;
    case 'microsoft.network/networksecuritygroups': return `nsg-${word}-${index}`;
    case 'microsoft.network/virtualnetworks': return `vnet-${word}-${index}`;
    case 'microsoft.keyvault/vaults': return `kv-${word}-${index}`.slice(0, 24);
    case 'microsoft.sql/servers': return `sql-${word}-${index}`;
    case 'microsoft.web/sites': return `app-${word}-${index}`;
    case 'microsoft.containerregistry/registries': return `acr${word}${index}`.replace(/[^a-z0-9]/gi, '');
    default: return `${type.split('/')[1] ?? 'resource'}-${index}`;
  }
}

/** Builds the whole synthetic tenant once, deterministically. Called a single time per generator
 *  run — resource identity (id, type, location) never changes across simulated days; only which
 *  rules a resource violates changes day to day (see violation-engine.ts). */
export function buildEstate(): Estate {
  const rng = mulberry32(ESTATE_SEED);
  const resources: EstateResource[] = [];

  for (const sub of DEMO_SUBSCRIPTIONS) {
    const rgs = resourceGroupsFor(sub.name, rng);
    for (const rg of rgs) {
      const count = 12 + Math.floor(rng() * 10);
      for (let i = 0; i < count; i++) {
        const type = pickWeighted(TYPE_WEIGHTS, rng);
        const meta = TYPE_META[type];
        const location = pick(REGIONS, rng);
        const name = nameFor(type, rg, i, rng);
        const id = `/subscriptions/${sub.id}/resourceGroups/${rg}/providers/${meta.provider}/${meta.segment}/${name}`;
        const hasTags = rng() > 0.12;
        const tags = hasTags
          ? { Environment: rg.endsWith('-dev') ? 'dev' : 'prod', Owner: pick(OWNERS, rng) }
          : null;
        resources.push({ id, name, type, location, resourceGroup: rg, subscriptionId: sub.id, tags });
      }
    }
  }

  return { resources, byId: new Map(resources.map(r => [r.id, r])) };
}
