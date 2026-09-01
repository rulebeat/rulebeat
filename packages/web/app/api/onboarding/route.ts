import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { writeAudit } from '@/lib/db/audit';
import { getOnboardingState, setOnboardingState } from '@/lib/onboarding';

export async function GET() {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;
  return NextResponse.json(await getOnboardingState());
}

/**
 * `skip` and `complete` are kept as distinct terminal statuses (never collapsed into one "done")
 * so B4 can later report "setup was skipped" vs "setup completed", and Settings can offer a
 * "Resume setup" action that only makes sense for the skipped case.
 */
export async function PUT(req: Request) {
  const actor = await requireRole('azure:manage');
  if (actor instanceof NextResponse) return actor;

  const body = await parseJsonBody<{ action?: 'step' | 'skip' | 'complete'; lastStep?: number }>(req);
  if (body instanceof NextResponse) return body;

  if (body.action === 'skip') {
    const result = await setOnboardingState({ status: 'skipped' });
    await writeAudit({
      actor,
      action: 'onboarding.skip',
      entityType: 'onboarding',
      summary: `${actor.email} skipped first-run setup`,
    });
    return NextResponse.json(result);
  }
  if (body.action === 'complete') {
    const result = await setOnboardingState({
      status: 'done',
      completedAt: new Date().toISOString(),
      completedBy: actor.email,
    });
    await writeAudit({
      actor,
      action: 'onboarding.complete',
      entityType: 'onboarding',
      summary: `${actor.email} completed first-run setup`,
    });
    return NextResponse.json(result);
  }
  if (body.action === 'step' && typeof body.lastStep === 'number') {
    return NextResponse.json(await setOnboardingState({ lastStep: body.lastStep }));
  }
  return NextResponse.json(await getOnboardingState());
}
