import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { getArmToken, armFetch } from '@/lib/arm';

interface ManagementGroupsPage {
  value: { name: string; properties?: { displayName?: string } }[];
  nextLink?: string;
}

export async function GET() {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  try {
    const token = await getArmToken();

    const mgs: { id: string; name: string }[] = [];
    let url: string | null = 'https://management.azure.com/providers/Microsoft.Management/managementGroups?api-version=2020-05-01&$top=100';

    while (url) {
      const data: ManagementGroupsPage = await armFetch<ManagementGroupsPage>(url, token);
      for (const mg of data.value) {
        mgs.push({ id: mg.name, name: mg.properties?.displayName ?? mg.name });
      }
      url = data.nextLink ?? null;
    }

    mgs.sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json(mgs);
  } catch (err) {
    return serverError('Failed to list Azure management groups', err);
  }
}
