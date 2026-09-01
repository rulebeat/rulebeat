import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { getCategory } from '@/lib/db/categories';
import { runCategoryScan } from '@/lib/scan-runner';
import { writeAudit } from '@/lib/db/audit';

export async function POST() {
  const actor = await requireRole('scans:run');
  if (actor instanceof NextResponse) return actor;

  const category = await getCategory('identity');
  if (!category) return NextResponse.json({ error: 'Identity category not found' }, { status: 404 });

  await writeAudit({
    actor,
    action: 'scan.run',
    entityType: 'scan',
    summary: 'Started an identity scan',
    details: { category: category.id },
  });

  try {
    const { summary } = await runCategoryScan(category, { triggeredBy: 'manual' });
    return NextResponse.json(summary);
  } catch (err) {
    return serverError('Identity scan failed', err);
  }
}
