import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { getCategory } from '@/lib/db/categories';
import { runCategoryScan } from '@/lib/scan-runner';
import { writeAudit } from '@/lib/db/audit';

export async function POST(
  _: Request,
  { params }: { params: Promise<{ category: string }> },
) {
  const actor = await requireRole('scans:run');
  if (actor instanceof NextResponse) return actor;

  const { category: slug } = await params;
  const category = await getCategory(slug);
  if (!category) return NextResponse.json({ error: `Unknown category: ${slug}` }, { status: 404 });

  await writeAudit({
    actor,
    action: 'scan.run',
    entityType: 'scan',
    summary: `Started a scan of the ${category.label} category`,
    details: { category: category.id },
  });

  try {
    const { summary } = await runCategoryScan(category, { triggeredBy: 'manual' });
    return NextResponse.json(summary);
  } catch (err) {
    return serverError('Scan failed', err);
  }
}
