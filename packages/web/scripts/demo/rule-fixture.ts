import type { EstateResource } from './estate';
import type { Severity } from '@rulebeat/core';

/** How the fake ARG answers one rule's query for the resources currently selected as violating it
 *  on a given simulated day (selection itself is `violation-engine.ts`'s job — this only shapes
 *  the row once a resource has been chosen). `buildRow` must return exactly the columns the real
 *  rule's `rawKql` would project, no more: a rulebeat-core rule projects full identity columns
 *  (type/location/resourceGroup/subscriptionId), so its rows never need the runner's enrichment
 *  follow-up query; most APRL rules project only `id`/`name`/`tags` plus their own evidence
 *  columns, so their rows deliberately omit type/location/resourceGroup/subscriptionId and the
 *  fake context's enrichment handler (fake-context.ts) has to answer for them, exactly like real
 *  ARG-backed APRL findings do. */
export interface RuleFixture {
  ruleId: string;
  resourceTypes: string[]; // lowercase ARM types; [] = every resource is a candidate (tag rules)
  severity: Severity;
  buildRow: (resource: EstateResource) => Record<string, unknown>;
}

export function identityColumns(r: EstateResource): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    location: r.location,
    resourceGroup: r.resourceGroup,
    subscriptionId: r.subscriptionId,
  };
}
