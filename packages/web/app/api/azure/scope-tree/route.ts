import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { getArmToken, getArmTenantId, armFetch } from '@/lib/arm';

export interface ScopeTreeNode {
  id: string;
  name: string;
  type: 'managementGroup' | 'subscription';
  children?: ScopeTreeNode[];
}

export interface ScopeTree {
  tenantId: string;
  tenantName: string;
  children: ScopeTreeNode[];
}

interface RawChild {
  name: string;
  type: string;
  displayName?: string;
  children?: RawChild[] | null;
}

function mapChildren(raw: RawChild[]): ScopeTreeNode[] {
  return raw.map(child => {
    const isSub = child.type === '/subscriptions';
    const node: ScopeTreeNode = {
      id: child.name,
      name: child.displayName ?? child.name,
      type: isSub ? 'subscription' : 'managementGroup',
    };
    if (!isSub && child.children?.length) {
      node.children = mapChildren(child.children);
    }
    return node;
  });
}

export async function GET() {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  try {
    const tenantId = await getArmTenantId();
    const token = await getArmToken();

    const data = await armFetch<{
      name: string;
      properties: { displayName?: string; children?: RawChild[] | null };
    }>(
      `https://management.azure.com/providers/Microsoft.Management/managementGroups/${tenantId}?api-version=2020-05-01&$expand=children&$recurse=true`,
      token,
    );

    const tree: ScopeTree = {
      tenantId,
      tenantName: data.properties?.displayName ?? 'Tenant Root Group',
      children: mapChildren(data.properties?.children ?? []),
    };

    return NextResponse.json(tree);
  } catch (err) {
    return serverError('Failed to load the Azure management group hierarchy', err);
  }
}
