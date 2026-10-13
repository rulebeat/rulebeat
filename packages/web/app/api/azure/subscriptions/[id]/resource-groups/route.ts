import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { azureError } from '@/lib/api-error';
import { createTenantContext } from '@/lib/azure-credential';
import type { TenantContext } from '@rulebeat/core';

const SUBSCRIPTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RESOURCE_GROUPS_KQL =
  "resourcecontainers | where type =~ 'microsoft.resources/subscriptions/resourcegroups' | project name | order by name asc";

/**
 * The resource groups of one subscription, for the Admin choosing someone's Scopes. Admin-only: it
 * lists a subscription's contents, which a person may not be allowed to see. The subscription is
 * the query's scope, so its id is never written into the KQL.
 */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole('users:manage', { readOnly: true });
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  if (!SUBSCRIPTION_ID.test(id)) return NextResponse.json({ error: 'Not a subscription id.' }, { status: 400 });

  let ctx: TenantContext;
  try {
    ctx = await createTenantContext(actor.access);
  } catch (err) {
    return azureError('Could not connect to Azure to list the resource groups', err);
  }

  try {
    const rows = await ctx.queryARG<{ name?: string }>(RESOURCE_GROUPS_KQL, { subscriptions: [id] });
    const names = rows.map(r => r.name).filter((n): n is string => typeof n === 'string' && n !== '');
    return NextResponse.json({ resourceGroups: names.sort((a, b) => a.localeCompare(b)) });
  } catch (err) {
    return azureError('Could not list the resource groups of this subscription', err);
  }
}
