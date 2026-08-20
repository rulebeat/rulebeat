import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { listDeliveriesForChannel } from '@/lib/db/notification-deliveries';

export async function GET(req: Request) {
  const actor = await requireRole('notifications:manage');
  if (actor instanceof NextResponse) return actor;

  const { searchParams } = new URL(req.url);
  const channelId = searchParams.get('channelId')?.trim() ?? '';
  if (!channelId) {
    return NextResponse.json({ error: 'channelId query parameter is required.' }, { status: 400 });
  }

  return NextResponse.json(listDeliveriesForChannel(channelId));
}
